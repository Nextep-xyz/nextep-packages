import type { Stage } from '@guardrails/src/types';
import { entry, evalAll, marked, msgs, oneStack, R, run, stack } from '@guardrails/test/helpers';

// Bordes de NX-WAF-001, NX-WAF-002 y NX-ALM-001 (spec guardrails-prod-readiness §3.3, §3.4 y §3.7) que los fixtures no cubren.

const att = (id: string, a: string): unknown => ({ 'Fn::GetAtt': [id, a] });
const alb = (p: Record<string, unknown> = {}): ReturnType<typeof R> => R('AWS::ElasticLoadBalancingV2::LoadBalancer', { Type: 'application', ...p });
const acl = (rules?: unknown[]): ReturnType<typeof R> => R('AWS::WAFv2::WebACL', { Scope: 'REGIONAL', DefaultAction: { Allow: {} }, ...(rules ? { Rules: rules } : {}) });
const assoc = (arn: unknown): ReturnType<typeof R> => R('AWS::WAFv2::WebACLAssociation', { ResourceArn: arn, WebACLArn: att('Acl', 'Arn') });
const managed = (override: unknown): Record<string, unknown> => ({ Name: 'g', Priority: 1, OverrideAction: override, Statement: { ManagedRuleGroupStatement: { Name: 'g', VendorName: 'AWS' } } });

describe('NX-WAF-001: bordes', () => {
  it('solo corre en prod', () => {
    const app = oneStack('E', { L: alb() });
    expect(run(app, 'prod', 'NX-WAF-001')).toEqual(['E/L']);
    for (const st of ['dev', 'stg', 'shared'] as Stage[]) expect(run(app, st, 'NX-WAF-001')).toEqual([]);
  });

  it('un ALB sin Type ni Scheme (los defaults: application, internet-facing) es sujeto', () => {
    expect(run(oneStack('E', { L: R('AWS::ElasticLoadBalancingV2::LoadBalancer', {}) }), 'prod', 'NX-WAF-001')).toEqual(['E/L']);
  });

  it('internal, network y gateway no son sujeto', () => {
    const app = oneStack('E', {
      I: alb({ Scheme: 'internal' }),
      N: R('AWS::ElasticLoadBalancingV2::LoadBalancer', { Type: 'network' }),
      G: R('AWS::ElasticLoadBalancingV2::LoadBalancer', { Type: 'gateway' }),
    });
    expect(run(app, 'prod', 'NX-WAF-001')).toEqual([]);
  });

  it('la asociación puede referenciar al ALB por Ref o por GetAtt del ARN, y también a través de SSM', () => {
    expect(run(oneStack('E', { L: alb(), Acl: acl(), A: assoc({ Ref: 'L' }) }), 'prod', 'NX-WAF-001')).toEqual([]);
    expect(run(oneStack('E', { L: alb(), Acl: acl(), A: assoc(att('L', 'LoadBalancerArn')) }), 'prod', 'NX-WAF-001')).toEqual([]);
    const lb = stack('Edge', { L: alb(), P: R('AWS::SSM::Parameter', { Name: '/shop/prod/edge/alb-arn', Type: 'String', Value: { Ref: 'L' } }) });
    const waf = stack('Waf', { Acl: acl(), A: assoc({ Ref: 'AlbArn' }) }, { Parameters: { AlbArn: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/shop/prod/edge/alb-arn' } } });
    expect(run([lb, waf], 'prod', 'NX-WAF-001')).toEqual([]);
  });

  it('una asociación a OTRO recurso del app (no al ALB) no lo cubre y no cuenta como opaca: el mensaje dice «sin asociación»', () => {
    const app = oneStack('E', { L: alb(), L2: alb({ Scheme: 'internal' }), Acl: acl(), A: assoc({ Ref: 'L2' }) });
    expect(run(app, 'prod', 'NX-WAF-001')).toEqual(['E/L']);
    expect(msgs(app, 'prod', 'NX-WAF-001')).toMatch(/sin AWS::WAFv2::WebACLAssociation/);
  });

  it('una asociación con ARN literal hace que el mensaje nombre la asociación dudosa (falla cerrado)', () => {
    const app = oneStack('E', { L: alb(), Acl: acl(), Dudosa: assoc('arn:aws:elasticloadbalancing:us-east-2:<ACCOUNT>:loadbalancer/app/x/y') });
    expect(msgs(app, 'prod', 'NX-WAF-001')).toMatch(/no se puede comprobar si la de E\/Dudosa es la suya/);
  });

  it('admite excepción declarada dos veces', () => {
    const app = oneStack('E', { L: marked(alb(), 'NX-WAF-001') });
    expect(run(app, 'prod', 'NX-WAF-001', { exceptions: [entry('NX-WAF-001')] })).toEqual([]);
  });
});

describe('NX-WAF-002: bordes (aviso)', () => {
  const log = (target = 'Acl'): ReturnType<typeof R> => R('AWS::WAFv2::LoggingConfiguration', { ResourceArn: att(target, 'Arn'), LogDestinationConfigs: ['arn:aws:logs:us-east-2:<ACCOUNT>:log-group:aws-waf-logs-x'] });

  it('es un aviso (severidad warn) y solo corre en prod', () => {
    const app = oneStack('E', { Acl: acl([managed({ Count: {} })]) });
    expect(evalAll(app, 'prod').filter((v) => v.ruleId === 'NX-WAF-002').map((v) => v.severity)).toEqual(['warn', 'warn']); // todo en count y sin logging
    for (const st of ['dev', 'stg', 'shared'] as Stage[]) expect(run(app, st, 'NX-WAF-002')).toEqual([]);
  });

  it('un grupo que bloquea basta para no avisar de «solo observa» (aunque haya otros en count)', () => {
    const app = oneStack('E', { Acl: acl([managed({ None: {} }), managed({ Count: {} })]), L: log() });
    expect(run(app, 'prod', 'NX-WAF-002')).toEqual([]);
  });

  it('un ACL sin ningún managed rule group no recibe el aviso de count (solo el de logging si falta)', () => {
    const app = oneStack('E', { Acl: acl([]) });
    expect(msgs(app, 'prod', 'NX-WAF-002')).toMatch(/sin AWS::WAFv2::LoggingConfiguration/);
    expect(msgs(app, 'prod', 'NX-WAF-002')).not.toMatch(/count/);
  });

  it('el aviso de count dice cuántos grupos y qué hacer', () => {
    expect(msgs(oneStack('E', { Acl: acl([managed({ Count: {} }), managed({ Count: {} })]), L: log() }), 'prod', 'NX-WAF-002')).toMatch(/todos sus managed rule groups \(2\) están en count.*OverrideAction None/);
  });

  it('Rules que no es una lista literal avisa que no pudo comprobarlo', () => {
    const app = oneStack('E', { Acl: R('AWS::WAFv2::WebACL', { Rules: { 'Fn::If': ['c', [], []] } }), L: log() });
    expect(msgs(app, 'prod', 'NX-WAF-002')).toMatch(/no se puede comprobar Rules/);
  });

  it('un override intrinsic NO avisa si otro grupo bloquea (la ACL bloquea algo)', () => {
    const app = oneStack('E', { Acl: acl([managed({ None: {} }), managed({ 'Fn::If': ['c', { Count: {} }, { None: {} }] })]), L: log() });
    expect(run(app, 'prod', 'NX-WAF-002')).toEqual([]);
  });

  it('la configuración de logging en otro stack, enlazada por export, cuenta', () => {
    const edge = stack('Edge', { Acl: acl([managed({ None: {} })]) }, { Outputs: { O: { Value: att('Acl', 'Arn'), Export: { Name: 'Edge:AclArn' } } } });
    const logs = stack('Logs', { L: R('AWS::WAFv2::LoggingConfiguration', { ResourceArn: { 'Fn::ImportValue': 'Edge:AclArn' }, LogDestinationConfigs: [] }) });
    expect(run([edge, logs], 'prod', 'NX-WAF-002')).toEqual([]);
  });

  it('admite excepción declarada dos veces (ajuste inicial deliberado)', () => {
    const app = oneStack('E', { Acl: marked(acl([managed({ Count: {} })]), 'NX-WAF-002'), L: log() });
    expect(run(app, 'prod', 'NX-WAF-002', { exceptions: [entry('NX-WAF-002')] })).toEqual([]);
  });
});

describe('NX-ALM-001: bordes (aviso)', () => {
  const alarm = (...actions: unknown[]): ReturnType<typeof R> => R('AWS::CloudWatch::Alarm', { AlarmActions: actions });
  const topic = (p: Record<string, unknown> = {}): ReturnType<typeof R> => R('AWS::SNS::Topic', p);
  const sub = (arn: unknown): ReturnType<typeof R> => R('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'ops@example.com', TopicArn: arn });

  it('es un aviso (severidad warn) y solo corre en prod', () => {
    const app = oneStack('O', { T: topic(), A: alarm({ Ref: 'T' }) });
    expect(evalAll(app, 'prod').filter((v) => v.ruleId === 'NX-ALM-001').map((v) => [v.severity, v.resource])).toEqual([['warn', 'T']]);
    for (const st of ['dev', 'stg', 'shared'] as Stage[]) expect(run(app, st, 'NX-ALM-001')).toEqual([]);
  });

  it('un topic que ninguna alarma usa no es sujeto', () => {
    expect(run(oneStack('O', { T: topic() }), 'prod', 'NX-ALM-001')).toEqual([]);
  });

  it('OKActions e InsufficientDataActions también cuentan como destino; también las alarmas compuestas', () => {
    const ok = R('AWS::CloudWatch::Alarm', { OKActions: [{ Ref: 'T' }] });
    const insuf = R('AWS::CloudWatch::Alarm', { InsufficientDataActions: [{ Ref: 'T' }] });
    const composite = R('AWS::CloudWatch::CompositeAlarm', { AlarmActions: [{ Ref: 'T' }] });
    for (const a of [ok, insuf, composite]) expect(run(oneStack('O', { T: topic(), A: a }), 'prod', 'NX-ALM-001')).toEqual(['O/T']);
  });

  it('un destino que NO es un topic del app (ARN literal) no es sujeto', () => {
    expect(run(oneStack('O', { A: alarm('arn:aws:sns:us-east-2:<ACCOUNT>:external') }), 'prod', 'NX-ALM-001')).toEqual([]);
  });

  it('el mensaje nombra la alarma y cuántas hay', () => {
    const app = oneStack('O', { T: topic(), A1: alarm({ Ref: 'T' }), A2: alarm({ Ref: 'T' }) });
    expect(msgs(app, 'prod', 'NX-ALM-001')).toMatch(/lo usa 2 alarmas, p\. ej\. O\/A1 y no tiene ninguna suscripción/);
  });

  it('la suscripción en otro stack (por export) cuenta; sin ella, el topic queda mudo', () => {
    const obs = stack('Obs', { T: topic() }, { Outputs: { O: { Value: { Ref: 'T' }, Export: { Name: 'Obs:TopicArn' } } } });
    const svc = stack('Svc', { A: alarm({ 'Fn::ImportValue': 'Obs:TopicArn' }) });
    const subs = stack('Subs', { S: sub({ 'Fn::ImportValue': 'Obs:TopicArn' }) });
    expect(run([obs, svc], 'prod', 'NX-ALM-001')).toEqual(['Obs/T']);
    expect(run([obs, svc, subs], 'prod', 'NX-ALM-001')).toEqual([]);
  });

  it('el salto por SSM de la alarma al topic (el patrón de los stacks de referencia) se sigue', () => {
    const obs = stack('Obs', { T: topic(), P: R('AWS::SSM::Parameter', { Name: '/shop/prod/alarm-topic-arn', Type: 'String', Value: { Ref: 'T' } }) });
    const svc = stack('Svc', { A: alarm({ Ref: 'TopicArn' }) }, { Parameters: { TopicArn: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/shop/prod/alarm-topic-arn' } } });
    expect(run([obs, svc], 'prod', 'NX-ALM-001')).toEqual(['Obs/T']);
  });

  it('Chatbot de Teams también cuenta como suscriptor', () => {
    const app = oneStack('O', { T: topic(), A: alarm({ Ref: 'T' }), C: R('AWS::Chatbot::MicrosoftTeamsChannelConfiguration', { SnsTopicArns: [{ Ref: 'T' }] }) });
    expect(run(app, 'prod', 'NX-ALM-001')).toEqual([]);
  });

  it('admite excepción declarada dos veces (suscripción fuera del app)', () => {
    const app = oneStack('O', { T: marked(topic(), 'NX-ALM-001'), A: alarm({ Ref: 'T' }) });
    expect(run(app, 'prod', 'NX-ALM-001', { exceptions: [entry('NX-ALM-001')] })).toEqual([]);
  });
});
