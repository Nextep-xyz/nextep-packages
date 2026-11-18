import { evaluate } from '@guardrails/src/engine';
import type { CfnResource, GuardrailsContext, StackTemplate, Stage } from '@guardrails/src/types';
import { NOW, oneStack, schedule, TAGS_DEV, universalArn } from '@guardrails/test/helpers';

// Bordes de cada regla que los fixtures no cubren. Cada caso evalúa el catálogo completo y filtra por la regla bajo prueba.

const run = (app: StackTemplate[], stage: Stage, ruleId: string, over: Partial<GuardrailsContext> = {}): string[] =>
  evaluate(app, { stage, exceptions: [], now: NOW, ...over })
    .filter((v) => v.ruleId === ruleId)
    .map((v) => `${v.stack}/${v.resource}`);

const db = (cls: unknown, props: Record<string, unknown> = {}): CfnResource => ({ Type: 'AWS::RDS::DBInstance', Properties: { DBInstanceClass: cls, Engine: 'postgres', ...props } });
const svc = (props: Record<string, unknown> = { LaunchType: 'FARGATE' }): CfnResource => ({ Type: 'AWS::ECS::Service', Properties: props });
const target = (svcId: string, props: Record<string, unknown>): CfnResource => ({
  Type: 'AWS::ApplicationAutoScaling::ScalableTarget',
  Properties: { ResourceId: { 'Fn::Join': ['', ['service/c/', { 'Fn::GetAtt': [svcId, 'Name'] }]] }, MinCapacity: 1, MaxCapacity: 2, ...props },
});

describe('NX-FIN-001: bordes', () => {
  const bucket = (tags: unknown): StackTemplate[] => oneStack('App-Dev', { Bucket: { Type: 'AWS::S3::Bucket', Properties: { Tags: tags } } });

  it('un valor vacío cuenta como ausente', () => {
    const tags = [{ Key: 'Project', Value: '' }, { Key: 'Application', Value: 'Core' }, { Key: 'Environment', Value: 'dev' }];
    expect(run(bucket(tags), 'dev', 'NX-FIN-001')).toEqual(['App-Dev/Bucket']);
  });

  it('Environment fuera del conjunto {dev,stg,prod,shared} falla aunque el stage coincida de nombre (Dev ≠ dev)', () => {
    const tags = [{ Key: 'Project', Value: 'x' }, { Key: 'Application', Value: 'Core' }, { Key: 'Environment', Value: 'Dev' }];
    expect(run(bucket(tags), 'dev', 'NX-FIN-001')).toEqual(['App-Dev/Bucket']);
  });

  it('el mensaje avisa de la clave en minúscula (project) en vez de limitarse a decir "falta"', () => {
    const tags = [{ Key: 'project', Value: 'x' }, { Key: 'Application', Value: 'Core' }, { Key: 'Environment', Value: 'dev' }];
    const [v] = evaluate(bucket(tags), { stage: 'dev', exceptions: [] });
    expect(v?.message).toMatch(/Project/);
    expect(v?.message).toMatch(/project/);
  });

  it('el valor puede ser un intrinsic en Project/Application, pero Environment debe ser literal', () => {
    const ok = [{ Key: 'Project', Value: { Ref: 'P' } }, { Key: 'Application', Value: { Ref: 'A' } }, { Key: 'Environment', Value: 'dev' }];
    expect(run(bucket(ok), 'dev', 'NX-FIN-001')).toEqual([]);
    const bad = [{ Key: 'Project', Value: 'x' }, { Key: 'Application', Value: 'y' }, { Key: 'Environment', Value: { Ref: 'E' } }];
    expect(run(bucket(bad), 'dev', 'NX-FIN-001')).toEqual(['App-Dev/Bucket']);
  });

  it('un recurso con Tags intrinsic (no evaluable) no se juzga', () => {
    expect(run(bucket({ 'Fn::If': ['c', [], []] }), 'dev', 'NX-FIN-001')).toEqual([]);
  });

  it('con stage "shared" toda la corrida espera Environment=shared', () => {
    expect(run(bucket(TAGS_DEV), 'shared', 'NX-FIN-001')).toEqual(['App-Dev/Bucket']);
  });

  it('sharedStacks es una lista explícita: un stack llamado "Shared" que no está en la lista se trata como dev', () => {
    const shared = [{ Key: 'Project', Value: 'x' }, { Key: 'Application', Value: 'Core' }, { Key: 'Environment', Value: 'shared' }];
    const app = oneStack('Shared', { Bucket: { Type: 'AWS::S3::Bucket', Properties: { Tags: shared } } });
    expect(run(app, 'dev', 'NX-FIN-001')).toEqual(['Shared/Bucket']);
    expect(run(app, 'dev', 'NX-FIN-001', { sharedStacks: ['Shared'] })).toEqual([]);
  });
});

describe('NX-COST-002: bordes', () => {
  it('la clase se compara sin distinguir mayúsculas y cubre .nano', () => {
    expect(run(oneStack('Db-Dev', { A: db('db.t4g.MICRO'), B: db('db.t3.nano') }), 'dev', 'NX-COST-002')).toEqual(['Db-Dev/A', 'Db-Dev/B']);
  });

  it('una clase que no se puede resolver a un literal se reporta (no pasa en silencio)', () => {
    expect(run(oneStack('Db-Dev', { A: db({ Ref: 'Clase' }) }), 'dev', 'NX-COST-002')).toEqual(['Db-Dev/A']);
  });

  it('aplica también en prod y stg', () => {
    expect(run(oneStack('Db-Prod', { A: db('db.t4g.micro') }), 'prod', 'NX-COST-002')).toEqual(['Db-Prod/A']);
    expect(run(oneStack('Db-Stg', { A: db('db.t4g.micro') }), 'stg', 'NX-COST-002')).toEqual(['Db-Stg/A']);
  });
});

describe('NX-COST-003: bordes', () => {
  const cluster = (value: unknown): StackTemplate[] => oneStack('Cl', { C: { Type: 'AWS::ECS::Cluster', Properties: { ClusterSettings: [{ Name: 'containerInsights', Value: value }] } } });

  it('en prod se admite (la regla solo aplica a dev y stg)', () => {
    expect(run(cluster('enabled'), 'prod', 'NX-COST-003')).toEqual([]);
  });

  it('en stg falla', () => {
    expect(run(cluster('enabled'), 'stg', 'NX-COST-003')).toEqual(['Cl/C']);
  });

  it('un valor no literal se reporta', () => {
    expect(run(cluster({ Ref: 'V' }), 'dev', 'NX-COST-003')).toEqual(['Cl/C']);
  });

  it('otros ClusterSettings no cuentan', () => {
    const app = oneStack('Cl', { C: { Type: 'AWS::ECS::Cluster', Properties: { ClusterSettings: [{ Name: 'otro', Value: 'enabled' }] } } });
    expect(run(app, 'dev', 'NX-COST-003')).toEqual([]);
  });
});

describe('NX-POWER-001: bordes (prod)', () => {
  const sched = (action: string): StackTemplate[] => oneStack('P', { S: schedule('cron(0 20 * * ? *)', action) });

  it.each(['rds:stopDBInstance', 'rds:stopDBCluster', 'ec2:stopInstances', 'ecs:updateService', 'RDS:STOPDBINSTANCE'])('el target universal %s es un apagado', (action) => {
    expect(run(sched(action), 'prod', 'NX-POWER-001')).toEqual(['P/S']);
  });

  it.each(['rds:startDBInstance', 'ec2:startInstances', 'rds:startDBCluster'])('el target %s no lo es', (action) => {
    expect(run(sched(action), 'prod', 'NX-POWER-001')).toEqual([]);
  });

  it('un target universal cuya acción no se puede resolver se reporta (no hace pasar la regla en silencio)', () => {
    const arn = { 'Fn::Join': ['', ['arn:aws:scheduler:::aws-sdk:rds:', { Ref: 'Accion' }]] };
    const app = oneStack('P', { S: { Type: 'AWS::Scheduler::Schedule', Properties: { ScheduleExpression: 'rate(1 day)', Target: { Arn: arn } } } });
    expect(run(app, 'prod', 'NX-POWER-001')).toEqual(['P/S']);
  });

  it('un target que no es universal (Lambda por GetAtt) no se juzga', () => {
    const app = oneStack('P', { S: { Type: 'AWS::Scheduler::Schedule', Properties: { ScheduleExpression: 'rate(1 day)', Target: { Arn: { 'Fn::GetAtt': ['Fn', 'Arn'] } } } } });
    expect(run(app, 'prod', 'NX-POWER-001')).toEqual([]);
  });

  it('un schedule DESHABILITADO sigue contando (se puede habilitar desde la consola)', () => {
    expect(run(oneStack('P', { S: schedule('cron(0 20 * * ? *)', 'rds:stopDBInstance', 'DISABLED') }), 'prod', 'NX-POWER-001')).toEqual(['P/S']);
  });

  it('MinCapacity como string "0" también es apagado', () => {
    expect(run(oneStack('P', { T: target('Api', { MinCapacity: '0' }) }), 'prod', 'NX-POWER-001')).toEqual(['P/T']);
  });

  it('no aplica en dev ni stg: ahí el apagado es lo esperado', () => {
    expect(run(sched('rds:stopDBInstance'), 'dev', 'NX-POWER-001')).toEqual([]);
    expect(run(sched('rds:stopDBInstance'), 'stg', 'NX-POWER-001')).toEqual([]);
  });
});

describe('NX-POWER-002: bordes', () => {
  it('un servicio con CapacityProviderStrategy FARGATE_SPOT cuenta como Fargate', () => {
    const app = oneStack('S-Dev', { Api: svc({ CapacityProviderStrategy: [{ CapacityProvider: 'FARGATE_SPOT', Weight: 1 }] }) });
    expect(run(app, 'dev', 'NX-POWER-002')).toEqual(['S-Dev/Api']);
  });

  it('el ScalableTarget debe estar en el MISMO template: uno en otro stack no cuenta', () => {
    const app = [...oneStack('S-Dev', { Api: svc() }), ...oneStack('Scale-Dev', { T: target('Api', { MinCapacity: 0 }) })];
    expect(run(app, 'dev', 'NX-POWER-002')).toEqual(['S-Dev/Api']);
  });

  it('un ScalableTarget de OTRO servicio del mismo template no cuenta', () => {
    const app = oneStack('S-Dev', { Api: svc(), Worker: svc(), T: target('Worker', { MinCapacity: 0 }) });
    expect(run(app, 'dev', 'NX-POWER-002')).toEqual(['S-Dev/Api']);
  });

  it('en prod no aplica (ahí manda NX-POWER-001)', () => {
    expect(run(oneStack('S-Prod', { Api: svc() }), 'prod', 'NX-POWER-002')).toEqual([]);
  });

  it('admite excepción declarada dos veces', () => {
    const api = { ...svc(), Metadata: { 'nextep:exception': ['NX-POWER-002'] } };
    const entry = { id: 'EXC-2', guard: 'NX-POWER-002', reason: 'Servicio con estado: no puede apagarse', owner: 'devops', expires: '2027-01-01' };
    expect(run(oneStack('S-Dev', { Api: api }), 'dev', 'NX-POWER-002', { exceptions: [entry] })).toEqual([]);
  });
});

describe('NX-POWER-003: bordes', () => {
  const power = (...sch: [string, string, string?][]): StackTemplate[] =>
    oneStack('Power-Dev', Object.fromEntries(sch.map(([id, action, state], i) => [id + i, schedule('cron(30 20 ? * MON-FRI *)', action, state ?? 'ENABLED')])));
  const database = oneStack('Db-Dev', { Database: db('db.t4g.small') });

  it('falta solo el start', () => {
    expect(run([...database, ...power(['Stop', 'rds:stopDBInstance'])], 'dev', 'NX-POWER-003')).toEqual(['Db-Dev/Database']);
  });

  it('un stop DESHABILITADO no cuenta como apagado programado', () => {
    expect(run([...database, ...power(['Start', 'rds:startDBInstance'], ['Stop', 'rds:stopDBInstance', 'DISABLED'])], 'dev', 'NX-POWER-003')).toEqual(['Db-Dev/Database']);
  });

  it('sin ninguna RDS no hay nada que exigir', () => {
    expect(run(oneStack('X-Dev', { Q: { Type: 'AWS::SQS::Queue', Properties: {} } }), 'dev', 'NX-POWER-003')).toEqual([]);
  });

  it('Aurora Serverless v2 (db.serverless) se omite', () => {
    expect(run(oneStack('Db-Dev', { W: db('db.serverless', { DBClusterIdentifier: { Ref: 'C' } }) }), 'dev', 'NX-POWER-003')).toEqual([]);
  });

  it('una instancia de un clúster Aurora aprovisionado exige acciones de clúster (stopDBCluster/startDBCluster)', () => {
    const aurora = oneStack('Db-Dev', { W: db('db.r6g.large', { DBClusterIdentifier: { Ref: 'C' } }) });
    expect(run([...aurora, ...power(['Start', 'rds:startDBInstance'], ['Stop', 'rds:stopDBInstance'])], 'dev', 'NX-POWER-003')).toEqual(['Db-Dev/W']);
    expect(run([...aurora, ...power(['Start', 'rds:startDBCluster'], ['Stop', 'rds:stopDBCluster'])], 'dev', 'NX-POWER-003')).toEqual([]);
  });

  it('en prod no aplica', () => {
    expect(run(oneStack('Db-Prod', { Database: db('db.t4g.medium') }), 'prod', 'NX-POWER-003')).toEqual([]);
  });

  it('el schedule puede vivir en cualquier stack del app (cruce entre stacks, spikes S2)', () => {
    const app = [...database, ...oneStack('A-Dev', {}), ...power(['Start', 'rds:startDBInstance'], ['Stop', 'rds:stopDBInstance'])];
    expect(run(app, 'dev', 'NX-POWER-003')).toEqual([]);
  });
});

describe('NX-POWER-004: bordes', () => {
  const stop = (expr: string): StackTemplate[] => oneStack('Power-Dev', { Stop: schedule(expr, 'rds:stopDBInstance') });

  it('rate() corre sin restricción de día: falla', () => {
    expect(run(stop('rate(1 day)'), 'dev', 'NX-POWER-004')).toEqual(['Power-Dev/Stop']);
  });

  it('at() es de una sola vez: no aplica', () => {
    expect(run(stop('at(2026-12-01T20:00:00)'), 'dev', 'NX-POWER-004')).toEqual([]);
  });

  it('una expresión ilegible se reporta', () => {
    expect(run(stop('cron(basura)'), 'dev', 'NX-POWER-004')).toEqual(['Power-Dev/Stop']);
  });

  it('solo mira los schedules de stopDBInstance: el stop de workloads es idempotente y puede correr todos los días', () => {
    const app = oneStack('Power-Dev', { StopSvc: schedule('cron(0 20 * * ? *)', 'ecs:updateService'), StopInstances: schedule('cron(0 20 * * ? *)', 'ec2:stopInstances') });
    expect(run(app, 'dev', 'NX-POWER-004')).toEqual([]);
  });

  it('no admite excepción', () => {
    const s = { ...schedule('cron(0 20 * * ? *)', 'rds:stopDBInstance'), Metadata: { 'nextep:exception': ['NX-POWER-004'] } };
    const entry = { id: 'EXC-4', guard: 'NX-POWER-004', reason: 'Intento de excepción sobre regla que no la admite', owner: 'devops', expires: '2027-01-01' };
    expect(run(oneStack('Power-Dev', { Stop: s }), 'dev', 'NX-POWER-004', { exceptions: [entry] })).toEqual(['Power-Dev/Stop']);
  });

  it('el ARN universal se construye igual que en el synth real (helper de los tests)', () => {
    expect(JSON.stringify(universalArn('rds:stopDBInstance'))).toContain('aws-sdk:rds:stopDBInstance');
  });
});
