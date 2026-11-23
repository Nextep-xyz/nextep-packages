import * as fs from 'fs';
import * as path from 'path';
import { CW_RETENTION_VALUES, MAX_LOG_RETENTION_DAYS } from '@guardrails/src/rules/NX-LOG-001';
import type { CfnResource, Stage } from '@guardrails/src/types';
import { entry, evalAll, marked, msgs, oneStack, PKG_ROOT, R, run } from '@guardrails/test/helpers';

// Bordes de NX-LOG-001 (spec guardrails-prod-readiness §3.10) que los fixtures no cubren: GR-NX-2 (excepción por hallazgo), GR-NX-3 (el techo) y
// un caso por cada origen cubierto.

const lg = (days?: unknown, extra: Record<string, unknown> = {}): CfnResource => R('AWS::Logs::LogGroup', { ...(days === undefined ? {} : { RetentionInDays: days }), ...extra });
const fn = (p: Record<string, unknown> = {}, extra: Partial<CfnResource> = {}): CfnResource => R('AWS::Lambda::Function', { Runtime: 'nodejs22.x', Handler: 'i.h', Role: 'r', Code: { ZipFile: 'x' }, ...p }, extra);
const join = (...parts: unknown[]): unknown => ({ 'Fn::Join': ['', parts] });
const ID = 'NX-LOG-001';

describe('NX-LOG-001: el techo (GR-NX-3)', () => {
  it('es un valor válido de CloudWatch Logs', () => {
    expect(CW_RETENTION_VALUES).toContain(MAX_LOG_RETENTION_DAYS);
  });

  it('el doc de la regla nombra el techo y la lista de valores válidos (no puede divergir en silencio)', () => {
    const doc = fs.readFileSync(path.join(PKG_ROOT, 'docs', 'rules', `${ID}.md`), 'utf8');
    expect(doc).toContain(`MAX_LOG_RETENTION_DAYS = ${MAX_LOG_RETENTION_DAYS}`);
    for (const v of CW_RETENTION_VALUES) expect(doc).toMatch(new RegExp(`\\b${v}\\b`));
  });

  it('exactamente el techo pasa; el siguiente valor válido (400) lo excede y nombra el techo', () => {
    expect(run(oneStack('S', { L: lg(MAX_LOG_RETENTION_DAYS) }), 'dev', ID)).toEqual([]);
    expect(msgs(oneStack('S', { L: lg(400) }), 'dev', ID)).toContain(`excede el techo de ${MAX_LOG_RETENTION_DAYS} días`);
  });
});

describe('NX-LOG-001: corre en todos los stages', () => {
  it.each(['dev', 'stg', 'prod', 'shared'] as Stage[])('%s', (stage) => {
    expect(run(oneStack('S', { L: lg() }), stage, ID)).toEqual(['S/L']);
  });
});

describe('NX-LOG-001: excepción por hallazgo (GR-NX-2)', () => {
  const E = { exceptions: [entry(ID)] };

  it('«sin retención» NO se silencia con marca + entrada vigente y el mensaje lo dice', () => {
    const app = oneStack('S', { L: marked(lg(), ID) });
    expect(run(app, 'dev', ID, E)).toEqual(['S/L']);
    expect(msgs(app, 'dev', ID, E)).toMatch(/NO admite excepción/);
  });

  it('un valor inválido (0 o 100) tampoco admite excepción', () => {
    for (const v of [0, 100, -1]) expect(run(oneStack('S', { L: marked(lg(v), ID) }), 'dev', ID, E)).toEqual(['S/L']);
  });

  it('un origen implícito (Lambda sin log group) NO se silencia', () => {
    expect(run(oneStack('S', { F: marked(fn(), ID) }), 'dev', ID, E)).toEqual(['S/F']);
  });

  it('el exceso sobre el techo SÍ se silencia con marca + entrada vigente; sin la entrada, reaparece', () => {
    const app = oneStack('S', { L: marked(lg(731), ID) });
    expect(run(app, 'dev', ID, E)).toEqual([]);
    expect(run(app, 'dev', ID)).toEqual(['S/L']);
  });

  it('un destino externo (LoggingConfig.LogGroup que el app no declara) SÍ admite excepción', () => {
    const app = oneStack('S', { F: marked(fn({ LoggingConfig: { LogGroup: '/shared/central' } }), ID) });
    expect(run(app, 'dev', ID)).toEqual(['S/F']);
    expect(run(app, 'dev', ID, E)).toEqual([]);
  });

  it('un recurso con hallazgo exceptuable Y no exceptuable: la marca silencia solo el primero', () => {
    // La función escribe a un destino externo (exceptuable)… y además un ECS-style no aplica; usamos un LogGroup eterno vecino para el no exceptuable.
    const app = oneStack('S', { F: marked(fn({ LoggingConfig: { LogGroup: '/shared/central' } }), ID), L: marked(lg(), ID) });
    expect(run(app, 'dev', ID, E)).toEqual(['S/L']);
  });
});

describe('NX-LOG-001: Lambda', () => {
  it('el log group declarado por nombre (Ref a la función) cubre a la Lambda; un log group de OTRA función no', () => {
    expect(run(oneStack('S', { F: fn(), G: lg(30, { LogGroupName: join('/aws/lambda/', { Ref: 'F' }) }) }), 'dev', ID)).toEqual([]);
    expect(run(oneStack('S', { F: fn(), G: lg(30, { LogGroupName: join('/aws/lambda/', { Ref: 'Other' }) }) }), 'dev', ID)).toEqual(['S/F']);
  });

  it('FunctionName literal: el log group (incluso en otro stack) con ese nombre cubre a la Lambda', () => {
    const f = oneStack('A', { F: fn({ FunctionName: 'shop-worker' }) });
    const g = oneStack('B', { G: lg(30, { LogGroupName: '/aws/lambda/shop-worker' }) });
    expect(run([...f, ...g], 'dev', ID)).toEqual([]);
  });

  it('LoggingConfig.LogGroup que resuelve a un log group del app (por Ref o por nombre literal) cubre; su retención se juzga aparte', () => {
    expect(run(oneStack('S', { F: fn({ LoggingConfig: { LogGroup: { Ref: 'L' } } }), L: lg(30) }), 'dev', ID)).toEqual([]);
    expect(run(oneStack('S', { F: fn({ LoggingConfig: { LogGroup: '/app/x' } }), L: lg(30, { LogGroupName: '/app/x' }) }), 'dev', ID)).toEqual([]);
    expect(run(oneStack('S', { F: fn({ LoggingConfig: { LogGroup: { Ref: 'L' } } }), L: lg() }), 'dev', ID)).toEqual(['S/L']); // el eterno es L, no F
  });

  it('LoggingConfig sin LogGroup (solo nivel de log) sigue siendo implícito', () => {
    expect(run(oneStack('S', { F: fn({ LoggingConfig: { ApplicationLogLevel: 'INFO' } }) }), 'dev', ID)).toEqual(['S/F']);
  });

  it.each([
    ['Custom::LogRetention (helper de CDK)', 'S/LogRetentionaae0aa3c5b4d4f87b02d85b201efdd8a/Resource', /Lambda auxiliar de Custom::LogRetention.*logGroup/],
    ['framework de cr.Provider', 'S/Provider/framework-onEvent/Resource', /framework de un cr\.Provider.*logGroup/],
    ['CustomResourceProvider interno de CDK', 'S/Custom::VpcRestrictDefaultSGCustomResourceProvider/Handler', /CustomResourceProvider interno de CDK/],
    ['AwsCustomResource', 'S/AWS679f53fac002430cb0da5b7982bd2287/Resource', /AwsCustomResource/],
  ])('el mensaje identifica la Lambda de %s por su ruta de CDK', (_n, cdkPath, re) => {
    const app = oneStack('S', { F: fn({}, { Metadata: { 'aws:cdk:path': cdkPath } }) });
    expect(msgs(app, 'dev', ID)).toMatch(re);
  });

  it('Lambda sin pista de CDK: mensaje genérico con el arreglo', () => {
    expect(msgs(oneStack('S', { F: fn() }), 'dev', ID)).toMatch(/grupo implícito \/aws\/lambda\/<función>.*LoggingConfig\.LogGroup/);
  });
});

describe('NX-LOG-001: Custom::LogRetention y log groups declarados', () => {
  const retention = (days?: unknown): CfnResource => R('Custom::LogRetention', { ServiceToken: 't', LogGroupName: '/x', ...(days === undefined ? {} : { RetentionInDays: days }) });

  it('Custom::LogRetention sin RetentionInDays, con exceso o con un intrinsic', () => {
    expect(msgs(oneStack('S', { L: retention() }), 'dev', ID)).toMatch(/Custom::LogRetention sin RetentionInDays/);
    expect(msgs(oneStack('S', { L: retention(1827) }), 'dev', ID)).toMatch(/excede el techo/);
    expect(msgs(oneStack('S', { L: retention({ Ref: 'P' }) }), 'dev', ID)).toMatch(/no se puede comprobar RetentionInDays/);
    expect(run(oneStack('S', { L: retention(30) }), 'dev', ID)).toEqual([]);
  });

  it('RetentionInDays como texto ("30") se lee igual', () => {
    expect(run(oneStack('S', { L: lg('30') }), 'dev', ID)).toEqual([]);
    expect(run(oneStack('S', { L: lg('731') }), 'dev', ID)).toEqual(['S/L']);
  });
});

describe('NX-LOG-001: orígenes implícitos y explícitos', () => {
  it('RDS: cada export necesita su log group; un Aurora (cluster) usa /aws/rds/cluster/', () => {
    const exp = ['postgresql', 'upgrade'];
    const db = R('AWS::RDS::DBInstance', { Engine: 'postgres', EnableCloudwatchLogsExports: exp });
    const one = lg(30, { LogGroupName: join('/aws/rds/instance/', { Ref: 'Db' }, '/postgresql') });
    const app = oneStack('S', { Db: db, One: one });
    expect(msgs(app, 'dev', ID)).toMatch(/exporta el log "upgrade"/);
    expect(msgs(app, 'dev', ID)).not.toMatch(/exporta el log "postgresql"/);
    const cluster = R('AWS::RDS::DBCluster', { Engine: 'aurora-postgresql', EnableCloudwatchLogsExports: ['postgresql'] });
    expect(msgs(oneStack('S', { C: cluster }), 'dev', ID)).toContain('/aws/rds/cluster/');
    const named = lg(30, { LogGroupName: join('/aws/rds/cluster/', { Ref: 'C' }, '/postgresql') });
    expect(run(oneStack('S', { C: cluster, N: named }), 'dev', ID)).toEqual([]);
  });

  it('RDS: un DBInstanceIdentifier literal permite emparejar el log group por nombre fijo', () => {
    const db = R('AWS::RDS::DBInstance', { Engine: 'postgres', DBInstanceIdentifier: 'shop-db', EnableCloudwatchLogsExports: ['postgresql'] });
    expect(run(oneStack('S', { Db: db, L: lg(30, { LogGroupName: '/aws/rds/instance/shop-db/postgresql' }) }), 'dev', ID)).toEqual([]);
  });

  it('RDS: EnableCloudwatchLogsExports que es un intrinsic falla cerrado (con excepción)', () => {
    const db = R('AWS::RDS::DBInstance', { Engine: 'postgres', EnableCloudwatchLogsExports: { Ref: 'P' } });
    expect(msgs(oneStack('S', { Db: db }), 'dev', ID)).toMatch(/no se puede comprobar EnableCloudwatchLogsExports/);
    expect(run(oneStack('S', { Db: marked(db, ID) }), 'dev', ID, { exceptions: [entry(ID)] })).toEqual([]);
  });

  it('CodeBuild: sin LogsConfig es implícito; Status DISABLED no escribe; el log group por nombre /aws/codebuild/<proyecto> cubre', () => {
    expect(run(oneStack('S', { B: R('AWS::CodeBuild::Project', {}) }), 'dev', ID)).toEqual(['S/B']);
    expect(run(oneStack('S', { B: R('AWS::CodeBuild::Project', { LogsConfig: { CloudWatchLogs: { Status: 'DISABLED' } } }) }), 'dev', ID)).toEqual([]);
    const named = lg(30, { LogGroupName: join('/aws/codebuild/', { Ref: 'B' }) });
    expect(run(oneStack('S', { B: R('AWS::CodeBuild::Project', {}), N: named }), 'dev', ID)).toEqual([]);
    expect(msgs(oneStack('S', { B: R('AWS::CodeBuild::Project', { LogsConfig: { CloudWatchLogs: { GroupName: '/ext' } } }) }), 'dev', ID)).toMatch(/no es un log group que el app declare/);
  });

  it('ECS awslogs: group declarado pasa; no declarado con create-group es implícito (sin excepción); sin create-group es externo (con excepción)', () => {
    const task = (opts: Record<string, unknown>): CfnResource => R('AWS::ECS::TaskDefinition', { ContainerDefinitions: [{ Name: 'a', Image: 'x', LogConfiguration: { LogDriver: 'awslogs', Options: opts } }] });
    expect(run(oneStack('S', { T: task({ 'awslogs-group': { Ref: 'L' } }), L: lg(30) }), 'dev', ID)).toEqual([]);
    const implicit = oneStack('S', { T: marked(task({ 'awslogs-group': '/ecs/a', 'awslogs-create-group': 'true' }), ID) });
    expect(run(implicit, 'dev', ID, { exceptions: [entry(ID)] })).toEqual(['S/T']);
    const external = oneStack('S', { T: marked(task({ 'awslogs-group': '/ecs/a' }), ID) });
    expect(run(external, 'dev', ID)).toEqual(['S/T']);
    expect(run(external, 'dev', ID, { exceptions: [entry(ID)] })).toEqual([]);
  });

  it('ECS: un driver que no es awslogs (firelens) no es sujeto', () => {
    const t = R('AWS::ECS::TaskDefinition', { ContainerDefinitions: [{ Name: 'a', Image: 'x', LogConfiguration: { LogDriver: 'awsfirelens' } }] });
    expect(run(oneStack('S', { T: t }), 'dev', ID)).toEqual([]);
  });

  it('API Gateway: el log de ejecución implícito se cubre con un log group de ese nombre', () => {
    const stage = R('AWS::ApiGateway::Stage', { RestApiId: { Ref: 'Api' }, StageName: 'prod', MethodSettings: [{ LoggingLevel: 'ERROR' }] });
    expect(run(oneStack('S', { Api: R('AWS::ApiGateway::RestApi', {}), St: stage }), 'dev', ID)).toEqual(['S/St']);
    const exec = lg(30, { LogGroupName: join('API-Gateway-Execution-Logs_', { Ref: 'Api' }, '/prod') });
    expect(run(oneStack('S', { Api: R('AWS::ApiGateway::RestApi', {}), St: stage, G: exec }), 'dev', ID)).toEqual([]);
  });

  it('API Gateway v2 y Step Functions con destino externo: exceptuable', () => {
    const v2 = R('AWS::ApiGatewayV2::Stage', { AccessLogSettings: { DestinationArn: 'arn:aws:logs:us-east-2:<ACCOUNT>:log-group:/x' } });
    expect(run(oneStack('S', { V: v2 }), 'dev', ID)).toEqual(['S/V']);
    expect(run(oneStack('S', { V: marked(v2, ID) }), 'dev', ID, { exceptions: [entry(ID)] })).toEqual([]);
  });

  it('un destino que el app declara, referenciado por GetAtt del ARN, pasa', () => {
    const sm = R('AWS::StepFunctions::StateMachine', { LoggingConfiguration: { Destinations: [{ CloudWatchLogsLogGroup: { LogGroupArn: { 'Fn::GetAtt': ['L', 'Arn'] } } }] } });
    expect(run(oneStack('S', { Sm: sm, L: lg(30) }), 'dev', ID)).toEqual([]);
  });

  it('VPC Flow Logs a S3 no es sujeto; a CloudWatch con un grupo ajeno, sí (exceptuable)', () => {
    const s3 = R('AWS::EC2::FlowLog', { LogDestinationType: 's3', LogDestination: 'arn:aws:s3:::b' });
    const cw = R('AWS::EC2::FlowLog', { LogGroupName: '/vpc/flow' });
    expect(run(oneStack('S', { F: s3 }), 'dev', ID)).toEqual([]);
    expect(run(oneStack('S', { F: cw }), 'dev', ID)).toEqual(['S/F']);
  });

  it('un mensaje nombra regla, stack y recurso en cada origen', () => {
    const app = oneStack('Svc', { F: fn(), L: lg() });
    for (const v of evalAll(app, 'dev').filter((x) => x.ruleId === ID)) {
      expect(v.message).toContain(`[${ID}]`);
      expect(v.message).toContain(`Svc/${v.resource as string}`);
    }
  });
});
