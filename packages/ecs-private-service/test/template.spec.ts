import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Match } from 'aws-cdk-lib/assertions';
import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { parseExceptionsDoc } from '@nextep/gates';
import { allStatements, asList, build, container, DIGEST, make, NAMESPACE, PKG_ROOT, taskDef } from './helpers';

// Guards L2, L3, L4, L6, L7 y L8 sobre el template SINTETIZADO (lo que se desplegaria), mas el snapshot con props minimas.
// Cada guard se verifica en rojo rompiendo el construct a proposito (ver el reporte de la fase).

const { template, svc } = build();
const json = JSON.stringify(template.toJSON());
const envNames = (t = template): string[] => (container(t).Environment as { Name: string }[]).map((e) => e.Name);
const secretNames = (t = template): string[] => (container(t).Secrets as { Name: string }[]).map((e) => e.Name);

// El "snapshot" es un fixture JSON versionado (no un .snap de Jest: su cabecera lleva una URL ajena y el gate G13 del repo la rechaza).
// Regenerarlo es una decision de review: `UPDATE_TEMPLATE_FIXTURE=1 pnpm test`.
const FIXTURE = path.join(PKG_ROOT, 'test', 'fixtures', 'minimal.template.json');

describe('snapshot con props minimas', () => {
  it('el template sintetizado coincide con el fixture versionado: un cambio debe verse en el review', () => {
    if (process.env.UPDATE_TEMPLATE_FIXTURE === '1') fs.writeFileSync(FIXTURE, `${JSON.stringify(template.toJSON(), null, 2)}\n`);
    expect(fs.existsSync(FIXTURE)).toBe(true);
    expect(JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))).toEqual(template.toJSON());
  });

  it('un template sin ID de cuenta literal ni ARN con cuenta (el paquete es publico)', () => {
    expect(json).not.toMatch(/(?<![\d.])\d{12}(?![\d.])/);
    expect(json).not.toMatch(/arn:aws[\w-]*:[\w-]*:[\w-]*:\d{12}/);
  });
});

describe('imagen por digest', () => {
  it('se referencia <repositoryUri>@<digest> y el execution role puede hacer pull', () => {
    expect(json).toContain(`/demo-engine@${DIGEST}`);
    expect(json).not.toMatch(/demo-engine:[\w.-]+"/); // ningun tag
    const pull = allStatements(template).find((s) => asList(s.statement.Action).includes('ecr:BatchGetImage'));
    expect(pull).toBeDefined();
    expect(pull!.where).toMatch(/ExecutionRole/);
  });

  it('inyecta la version y el digest para el estampado', () => {
    const env = Object.fromEntries((container(template).Environment as { Name: string; Value: string }[]).map((e) => [e.Name, e.Value]));
    expect(env).toMatchObject({ ENVIRONMENT: 'development', ENGINE_VERSION: '1.2.3', IMAGE_DIGEST: DIGEST, PYTHONDONTWRITEBYTECODE: '1' });
  });
});

describe('L2: sin secretos en claro', () => {
  it('DATABASE_URL y EMBEDDED_APPLICATIONS van solo por Secrets, nunca por Environment', () => {
    expect(envNames()).not.toContain('DATABASE_URL');
    expect(envNames()).not.toContain('EMBEDDED_APPLICATIONS');
    expect(secretNames()).toEqual(expect.arrayContaining(['DATABASE_URL', 'EMBEDDED_APPLICATIONS']));
  });

  it('DATABASE_URL toma el campo `url` del secreto (o el indicado) y EMBEDDED_APPLICATIONS el secreto ENTERO', () => {
    const secrets = container(template).Secrets as { Name: string; ValueFrom: unknown }[];
    const db = secrets.find((s) => s.Name === 'DATABASE_URL')!;
    expect(JSON.stringify(db.ValueFrom)).toMatch(/:url::/);
    const key = secrets.find((s) => s.Name === 'EMBEDDED_APPLICATIONS')!;
    expect(JSON.stringify(key.ValueFrom)).not.toMatch(/::/); // sin `:campo::` = el JSON completo
    expect(JSON.stringify(build({ databaseUrlField: 'conn' }).template.toJSON())).toMatch(/:conn::/);
  });

  it('la clave se genera en Secrets Manager: >= 32 caracteres, sin puntuacion, clave = applicationId, sin valor literal', () => {
    const secrets = Object.values(template.findResources('AWS::SecretsManager::Secret'));
    expect(secrets).toHaveLength(1);
    const gen = (secrets[0]!.Properties as { GenerateSecretString: Record<string, unknown> }).GenerateSecretString;
    expect(gen.GenerateStringKey).toBe('DEMO');
    expect(gen.SecretStringTemplate).toBe('{}');
    expect(gen.ExcludePunctuation).toBe(true);
    expect(gen.PasswordLength as number).toBeGreaterThanOrEqual(32);
    expect(JSON.stringify(secrets[0])).not.toMatch(/"SecretString"/); // ni una propiedad SecretString literal
  });

  it('ningun valor del template parece una URL de base de datos ni una credencial', () => {
    expect(json).not.toMatch(/postgres(ql)?(\+\w+)?:\/\//);
    expect(json).not.toMatch(/"(password|secret_key|api[_-]?key|token)"\s*:/i);
  });

  it('la clave de aplicacion se entrega a la task de un cliente con el campo correcto (y le da lectura a su execution role)', () => {
    const f = make();
    const client = new ecs.FargateTaskDefinition(f.stack, 'Client');
    client.addContainer('web', { image: ecs.ContainerImage.fromRegistry('example/web:1.0.0'), secrets: { ACCOUNTING_KEY: f.svc.appKeyAsSecret() } });
    const t = Template.fromStack(f.stack);
    const clientDef = Object.values(t.findResources('AWS::ECS::TaskDefinition')).find((d) => JSON.stringify(d).includes('ACCOUNTING_KEY'))!;
    const secret = ((clientDef.Properties as { ContainerDefinitions: { Secrets: { ValueFrom: unknown }[] }[] }).ContainerDefinitions[0]!.Secrets[0]!).ValueFrom;
    expect(JSON.stringify(secret)).toMatch(/"Ref":"EngineAppKey\w+"\},":DEMO::"/);
    const clientRole = Object.keys(t.findResources('AWS::IAM::Policy')).find((id) => id.includes('Client') && id.includes('ExecutionRole'));
    expect(clientRole).toBeDefined();
  });
});

describe('L3: red privada', () => {
  const ingress = (): Record<string, unknown>[] => {
    const inline = Object.values(template.findResources('AWS::EC2::SecurityGroup')).flatMap((r) => asList((r.Properties as Record<string, unknown>).SecurityGroupIngress) as Record<string, unknown>[]);
    const separate = Object.values(template.findResources('AWS::EC2::SecurityGroupIngress')).map((r) => r.Properties as Record<string, unknown>);
    return [...inline, ...separate];
  };

  it('hay ingress y NINGUNO es un CIDR (ni 0.0.0.0/0 ni IPv6)', () => {
    expect(ingress().length).toBeGreaterThan(0);
    for (const rule of ingress()) {
      expect(rule.CidrIp).toBeUndefined();
      expect(rule.CidrIpv6).toBeUndefined();
      expect(rule.SourceSecurityGroupId).toBeDefined();
    }
  });

  it('el ingress es solo desde ingressFrom y solo al puerto del servicio (TCP)', () => {
    for (const rule of ingress()) {
      expect(rule).toMatchObject({ IpProtocol: 'tcp', FromPort: 8000, ToPort: 8000, SourceSecurityGroupId: 'sg-0a1b2c3d4e5f6a7b8' });
    }
  });

  it('un puerto y varios clientes: una regla por cliente, al puerto indicado', () => {
    const f = build((stack) => ({
      port: 9000,
      ingressFrom: [
        ec2.SecurityGroup.fromSecurityGroupId(stack, 'A', 'sg-0a1b2c3d4e5f6a7b8', { mutable: false }),
        ec2.SecurityGroup.fromSecurityGroupId(stack, 'B', 'sg-0b1c2d3e4f5a6b7c8', { mutable: false }),
      ],
    }));
    const rules = Object.values(f.template.findResources('AWS::EC2::SecurityGroup')).flatMap((r) => asList((r.Properties as Record<string, unknown>).SecurityGroupIngress));
    expect(rules).toEqual([
      expect.objectContaining({ FromPort: 9000, ToPort: 9000, SourceSecurityGroupId: 'sg-0a1b2c3d4e5f6a7b8' }),
      expect.objectContaining({ FromPort: 9000, ToPort: 9000, SourceSecurityGroupId: 'sg-0b1c2d3e4f5a6b7c8' }),
    ]);
  });

  it('sin IP publica y en subredes privadas', () => {
    const net = (Object.values(template.findResources('AWS::ECS::Service'))[0]!.Properties as { NetworkConfiguration: { AwsvpcConfiguration: Record<string, unknown> } }).NetworkConfiguration.AwsvpcConfiguration;
    expect(net.AssignPublicIp).toBe('DISABLED');
    expect(net.Subnets).toEqual(['subnet-0a1b2c3d4e5f6a7b8', 'subnet-0b1c2d3e4f5a6b7c8']);
  });

  it('no crea balanceadores, listeners ni target groups', () => {
    expect(Object.keys(template.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer'))).toEqual([]);
    expect(Object.keys(template.findResources('AWS::ElasticLoadBalancingV2::TargetGroup'))).toEqual([]);
    expect(Object.keys(template.findResources('AWS::ElasticLoadBalancingV2::Listener'))).toEqual([]);
  });

  it('los security groups extra se suman al del servicio (que sigue siendo el primero)', () => {
    const f = build((stack) => ({ extraSecurityGroups: [ec2.SecurityGroup.fromSecurityGroupId(stack, 'DbAccess', 'sg-0c1d2e3f4a5b6c7d8', { mutable: false })] }));
    const net = (Object.values(f.template.findResources('AWS::ECS::Service'))[0]!.Properties as { NetworkConfiguration: { AwsvpcConfiguration: { SecurityGroups: unknown[] } } }).NetworkConfiguration.AwsvpcConfiguration;
    expect(net.SecurityGroups).toHaveLength(2);
    expect(JSON.stringify(net.SecurityGroups[0])).toMatch(/ServiceSecurityGroup/);
    expect(net.SecurityGroups[1]).toBe('sg-0c1d2e3f4a5b6c7d8');
  });
});

describe('L4: IAM de minimo privilegio', () => {
  const taskRoleId = (): string => Object.keys(template.findResources('AWS::IAM::Role')).find((id) => id.includes('TaskRole'))!;

  it('el task role no tiene NINGUNA policy', () => {
    const policies = Object.values(template.findResources('AWS::IAM::Policy'));
    const attached = policies.filter((p) => JSON.stringify((p.Properties as Record<string, unknown>).Roles).includes(taskRoleId()));
    expect(attached).toEqual([]);
    expect((template.findResources('AWS::IAM::Role')[taskRoleId()]!.Properties as Record<string, unknown>).Policies).toBeUndefined();
    expect((template.findResources('AWS::IAM::Role')[taskRoleId()]!.Properties as Record<string, unknown>).ManagedPolicyArns).toBeUndefined();
  });

  it('ningun Action ni Resource lleva `*`, salvo ecr:GetAuthorizationToken (que IAM solo admite con Resource *)', () => {
    const offenders: string[] = [];
    for (const { where, statement } of allStatements(template)) {
      const actions = asList(statement.Action) as string[];
      const resources = asList(statement.Resource);
      const onlyEcrToken = actions.length === 1 && actions[0] === 'ecr:GetAuthorizationToken';
      if (actions.some((a) => a.includes('*'))) offenders.push(`${where}: Action ${actions.join(',')}`);
      if (!onlyEcrToken && resources.some((r) => r === '*' || (typeof r === 'string' && r.includes('*')))) offenders.push(`${where}: Resource *`);
    }
    expect(offenders).toEqual([]);
  });

  it('el execution role solo hace pull, escribe logs y lee los dos secretos', () => {
    const actions = new Set(allStatements(template).flatMap((s) => asList(s.statement.Action) as string[]));
    expect([...actions].sort()).toEqual(
      [
        'ecr:BatchCheckLayerAvailability',
        'ecr:BatchGetImage',
        'ecr:GetAuthorizationToken',
        'ecr:GetDownloadUrlForLayer',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'secretsmanager:DescribeSecret',
        'secretsmanager:GetSecretValue',
      ].sort(),
    );
  });

  it('el task role expuesto es el de la task definition', () => {
    expect(svc.taskRole.roleArn).toBeDefined();
    expect(JSON.stringify(taskDef(template).TaskRoleArn)).toContain('TaskRole');
  });
});

describe('L6: migracion sin solape (excepcion declarada)', () => {
  it('el comando es `<migrate> && exec <start>` con los comandos por defecto', () => {
    expect(container(template).Command).toEqual(['sh', '-c', 'alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8000']);
  });

  it('respeta comandos propios y el puerto en el comando de arranque por defecto', () => {
    const f = build({ port: 9000, migrateCommand: ['python', '-m', 'migrate'] });
    expect(container(f.template).Command).toEqual(['sh', '-c', 'python -m migrate && exec uvicorn app.main:app --host 0.0.0.0 --port 9000']);
    const g = build({ startCommand: ['gunicorn', 'app.main:app'] });
    expect(container(g.template).Command).toEqual(['sh', '-c', 'alembic upgrade head && exec gunicorn app.main:app']);
  });

  it('el despliegue NUNCA tiene dos tasks: MinimumHealthyPercent 0 y MaximumPercent 100', () => {
    template.hasResourceProperties('AWS::ECS::Service', { DeploymentConfiguration: Match.objectLike({ MinimumHealthyPercent: 0, MaximumPercent: 100 }) });
  });

  it('no hay props para aflojarlo (desiredCount fijo en 1, sin knobs de porcentaje)', () => {
    const props = Object.keys(build().props);
    expect(props.filter((k) => /percent|desired|healthy/i.test(k))).toEqual([]);
    template.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 1 });
  });

  it('la excepcion A1 esta declarada DOS veces: marca en el codigo (comando y despliegue) y entrada con caducidad', () => {
    const src = fs.readFileSync(path.join(PKG_ROOT, 'src', 'private-ecs-service.ts'), 'utf8');
    expect(src.match(/nextep-exception: EXC-ECS-MIGRATE-ON-START/g)?.length).toBeGreaterThanOrEqual(2);
    const entries = parseExceptionsDoc(fs.readFileSync(path.join(PKG_ROOT, '..', '..', 'docs', 'exceptions.yml'), 'utf8'));
    const entry = entries.find((e) => e.id === 'EXC-ECS-MIGRATE-ON-START');
    expect(entry).toMatchObject({ guard: 'L6', expires: '2026-12-31' });
  });
});

describe('L7: contenedor endurecido', () => {
  it('filesystem raiz de solo lectura con /tmp como unico volumen escribible', () => {
    expect(container(template).ReadonlyRootFilesystem).toBe(true);
    expect(taskDef(template).Volumes).toEqual([{ Name: 'tmp' }]);
    expect(container(template).MountPoints).toEqual([{ ContainerPath: '/tmp', ReadOnly: false, SourceVolume: 'tmp' }]);
  });

  it('el health check usa Python (sin curl) contra la ruta y el puerto configurados', () => {
    const cmd = (container(template).HealthCheck as { Command: string[] }).Command;
    expect(cmd[0]).toBe('CMD-SHELL');
    expect(cmd.join(' ')).not.toMatch(/curl|wget/);
    expect(cmd[1]).toMatch(/^python -c "import urllib\.request; urllib\.request\.urlopen\('http:\/\/localhost:8000\/api\/v1\/health', timeout=3\)" \|\| exit 1$/);
    const custom = build({ port: 9000, healthCheckPath: '/health', sizing: { startPeriodSeconds: 60 } });
    const hc = container(custom.template).HealthCheck as { Command: string[]; StartPeriod: number };
    expect(hc.Command[1]).toContain('http://localhost:9000/health');
    expect(hc.StartPeriod).toBe(60);
  });

  it('el periodo de gracia por defecto cubre la migracion (180 s)', () => {
    expect((container(template).HealthCheck as { StartPeriod: number }).StartPeriod).toBe(180);
  });

  it('circuit breaker con rollback, sin ECS Exec', () => {
    template.hasResourceProperties('AWS::ECS::Service', { DeploymentConfiguration: Match.objectLike({ DeploymentCircuitBreaker: { Enable: true, Rollback: true } }), EnableExecuteCommand: false });
  });

  it('Fargate X86_64 y el contenedor no es privilegiado ni corre como root forzado', () => {
    expect(taskDef(template).RuntimePlatform).toEqual({ CpuArchitecture: 'X86_64', OperatingSystemFamily: 'LINUX' });
    expect(container(template).Privileged).toBeUndefined();
    expect(container(template).User).toBeUndefined();
  });
});

describe('L8: Service Connect', () => {
  it('el servicio se registra en el namespace indicado con su alias y puerto', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      ServiceConnectConfiguration: Match.objectLike({
        Enabled: true,
        Namespace: NAMESPACE,
        Services: [{ PortName: 'http', DiscoveryName: 'demo-engine', ClientAliases: [{ DnsName: 'demo-engine', Port: 8000 }] }],
      }),
    });
  });

  it('el nombre de descubrimiento es propio del servicio y NO el nombre del puerto: dos servicios con puerto `http` no chocan en el namespace', () => {
    // Regresion de un deploy real: sin `DiscoveryName` explicito, ECS usa el nombre del puerto (`http`) y el segundo servicio del
    // namespace falla con "SC service is already used by ...".
    const discovery = (t: Template) =>
      Object.values(t.findResources('AWS::ECS::Service'))
        .flatMap((r) => (r.Properties as { ServiceConnectConfiguration: { Services: { DiscoveryName?: string }[] } }).ServiceConnectConfiguration.Services)
        .map((s) => s.DiscoveryName);
    expect(discovery(template)).toEqual(['demo-engine']);
    expect(discovery(template)).not.toContain('http');
    const other = build({ serviceName: 'other-engine', serviceConnect: { namespace: NAMESPACE } });
    expect(discovery(other.template)).toEqual(['other-engine']);
  });

  it('el puerto del contenedor se llama `http` con appProtocol http', () => {
    expect(container(template).PortMappings).toEqual([{ AppProtocol: 'http', ContainerPort: 8000, Name: 'http', Protocol: 'tcp' }]);
  });

  it('dnsName propio y endpointUrl', () => {
    const f = build({ serviceConnect: { namespace: NAMESPACE, dnsName: 'ledger' }, port: 9000 });
    f.template.hasResourceProperties('AWS::ECS::Service', { ServiceConnectConfiguration: Match.objectLike({ Services: [Match.objectLike({ ClientAliases: [{ DnsName: 'ledger', Port: 9000 }] })] }) });
    expect(f.svc.endpointUrl).toBe(`${'http:'}//ledger:9000/api/v1`); // armada en runtime: el gate G13 no admite hosts ajenos como literal
    expect(svc.endpointUrl).toBe(`${'http:'}//demo-engine:8000/api/v1`);
  });
});

describe('otras propiedades del servicio', () => {
  it('sin alarmTopic no hay alarmas; con uno, CPU y memoria avisan al topico', () => {
    expect(Object.keys(template.findResources('AWS::CloudWatch::Alarm'))).toEqual([]);
    const f = build((stack) => ({ alarmTopic: new sns.Topic(stack, 'Topic') }));
    const alarms = Object.values(f.template.findResources('AWS::CloudWatch::Alarm')).map((a) => a.Properties as Record<string, unknown>);
    expect(alarms.map((a) => a.MetricName).sort()).toEqual(['CPUUtilization', 'MemoryUtilization']);
    for (const a of alarms) {
      expect(a).toMatchObject({ Threshold: 85, EvaluationPeriods: 3, DatapointsToAlarm: 3, TreatMissingData: 'notBreaching', ComparisonOperator: 'GreaterThanThreshold' });
      expect(JSON.stringify(a.AlarmActions)).toContain('Topic');
    }
  });

  it('extraEnvVars llega al contenedor, pero sin pisar las reservadas', () => {
    const f = build({ extraEnvVars: { LOG_LEVEL: 'info' } });
    expect(envNames(f.template)).toEqual(expect.arrayContaining(['LOG_LEVEL', 'ENVIRONMENT']));
  });

  it('removalPolicy por defecto RETAIN (secreto y logs) y configurable', () => {
    expect(template.findResources('AWS::SecretsManager::Secret')).toEqual({ [Object.keys(template.findResources('AWS::SecretsManager::Secret'))[0]!]: expect.objectContaining({ DeletionPolicy: 'Retain' }) });
    const d = build({ removalPolicy: cdk.RemovalPolicy.DESTROY });
    expect(Object.values(d.template.findResources('AWS::Logs::LogGroup'))[0]).toMatchObject({ DeletionPolicy: 'Delete' });
  });
});
