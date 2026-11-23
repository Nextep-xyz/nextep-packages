import type { CfnResource, Stage } from '@guardrails/src/types';
import { entry, marked, msgs, oneStack, R, run, stack } from '@guardrails/test/helpers';

// Bordes de las reglas de ECS (spec guardrails-prod-readiness §3.5 y §3.9) que los fixtures no cubren. Los fixtures (fail, fail-unresolvable, pass) los corre
// fixtures.spec.ts por disco.

const svc = (p: Record<string, unknown> = {}, extra: Partial<CfnResource> = {}): CfnResource => R('AWS::ECS::Service', { LaunchType: 'FARGATE', ...p }, extra);
const CB = { DeploymentCircuitBreaker: { Enable: true, Rollback: true } };
const target = (svcId: string, p: Record<string, unknown> = {}): CfnResource =>
  R('AWS::ApplicationAutoScaling::ScalableTarget', { MinCapacity: 1, MaxCapacity: 3, ResourceId: { 'Fn::Join': ['', ['service/c/', { 'Fn::GetAtt': [svcId, 'Name'] }]] }, ...p });

describe('NX-ECS-001: bordes', () => {
  it('corre en los cuatro stages (dev, stg, prod y shared)', () => {
    const app = oneStack('Svc', { S: svc() });
    for (const st of ['dev', 'stg', 'prod', 'shared'] as Stage[]) expect(run(app, st, 'NX-ECS-001')).toEqual(['Svc/S']);
  });

  it('el mensaje dice qué falta y cómo arreglarlo', () => {
    expect(msgs(oneStack('Svc', { S: svc() }), 'dev', 'NX-ECS-001')).toMatch(/\[NX-ECS-001\] Svc\/S \(AWS::ECS::Service\): sin .*DeploymentCircuitBreaker.*circuitBreaker/);
    expect(msgs(oneStack('Svc', { S: svc({ DeploymentConfiguration: { DeploymentCircuitBreaker: { Enable: true, Rollback: false } } }) }), 'dev', 'NX-ECS-001')).toMatch(/Rollback: false/);
  });

  it('Strategy ROLLING explícita sí es sujeto; una Strategy intrinsic falla cerrado', () => {
    expect(run(oneStack('Svc', { S: svc({ DeploymentConfiguration: { Strategy: 'ROLLING' } }) }), 'dev', 'NX-ECS-001')).toEqual(['Svc/S']);
    expect(msgs(oneStack('Svc', { S: svc({ DeploymentConfiguration: { Strategy: { Ref: 'P' } } }) }), 'dev', 'NX-ECS-001')).toMatch(/no se puede comprobar/);
  });

  it('un DeploymentController.Type intrinsic falla cerrado', () => {
    expect(msgs(oneStack('Svc', { S: svc({ DeploymentController: { Type: { Ref: 'P' } } }) }), 'dev', 'NX-ECS-001')).toMatch(/DeploymentController\.Type.*no es un literal/);
  });

  it('admite excepción declarada dos veces (marca + entrada)', () => {
    const app = oneStack('Svc', { S: marked(svc(), 'NX-ECS-001') });
    expect(run(app, 'dev', 'NX-ECS-001', { exceptions: [entry('NX-ECS-001')] })).toEqual([]);
    expect(run(app, 'dev', 'NX-ECS-001')).toEqual(['Svc/S']);
  });

  it('un servicio conforme no genera nada', () => {
    expect(run(oneStack('Svc', { S: svc({ DeploymentConfiguration: CB }) }), 'dev', 'NX-ECS-001')).toEqual([]);
  });
});

describe('NX-POWER-005: bordes', () => {
  it('solo corre en prod', () => {
    const app = oneStack('Svc', { S: svc({ DesiredCount: 0 }) });
    expect(run(app, 'prod', 'NX-POWER-005')).toEqual(['Svc/S']);
    for (const st of ['dev', 'stg', 'shared'] as Stage[]) expect(run(app, st, 'NX-POWER-005')).toEqual([]);
  });

  it('DesiredCount como texto ("0") se lee igual que el número', () => {
    expect(run(oneStack('Svc', { S: svc({ DesiredCount: '0' }) }), 'prod', 'NX-POWER-005')).toEqual(['Svc/S']);
    expect(run(oneStack('Svc', { S: svc({ DesiredCount: '1' }) }), 'prod', 'NX-POWER-005')).toEqual([]);
  });

  it('el ScalableTarget en OTRO stack, enlazado por export, también se juzga', () => {
    const owner = stack('Svc', { S: svc() }, { Outputs: { SvcName: { Value: { 'Fn::GetAtt': ['S', 'Name'] }, Export: { Name: 'Svc:ExportsOutputName' } } } });
    const scaling = stack('Scale', { T: R('AWS::ApplicationAutoScaling::ScalableTarget', { MinCapacity: 0, MaxCapacity: 2, ResourceId: { 'Fn::Join': ['', ['service/c/', { 'Fn::ImportValue': 'Svc:ExportsOutputName' }]] } }) });
    expect(run([owner, scaling], 'prod', 'NX-POWER-005')).toEqual(['Scale/T']);
  });

  it('con un servicio conforme, 001 y 005 no se contradicen: ambas pasan', () => {
    const app = oneStack('Svc', { S: svc({ DesiredCount: 2 }), T: target('S', { MinCapacity: 1 }) });
    expect(run(app, 'prod', 'NX-POWER-005')).toEqual([]);
    expect(run(app, 'prod', 'NX-POWER-001')).toEqual([]);
  });

  it('MinCapacity: 0 hace fallar AMBAS (se solapan a propósito)', () => {
    const app = oneStack('Svc', { S: svc({ DesiredCount: 2 }), T: target('S', { MinCapacity: 0 }) });
    expect(run(app, 'prod', 'NX-POWER-005')).toEqual(['Svc/T']);
    expect(run(app, 'prod', 'NX-POWER-001')).toEqual(['Svc/T']);
  });

  it('la excepción de 005 (marca + entrada) NO levanta 001: el motor las juzga por separado', () => {
    const app = oneStack('Svc', { S: svc({ DesiredCount: 2 }), T: marked(target('S', { MinCapacity: 0 }), 'NX-POWER-005') });
    const over = { exceptions: [entry('NX-POWER-005')] };
    expect(run(app, 'prod', 'NX-POWER-005', over)).toEqual([]);
    expect(run(app, 'prod', 'NX-POWER-001', over)).toEqual(['Svc/T']);
  });

  it('la acción programada con MinCapacity < 1 se reporta aunque el MinCapacity base sea 1', () => {
    const t = target('S', { ScheduledActions: [{ ScheduledActionName: 'n', Schedule: 'rate(1 day)', ScalableTargetAction: { MinCapacity: 0 } }] });
    expect(msgs(oneStack('Svc', { S: svc(), T: t }), 'prod', 'NX-POWER-005')).toMatch(/la acción programada 0 baja MinCapacity a 0/);
  });
});
