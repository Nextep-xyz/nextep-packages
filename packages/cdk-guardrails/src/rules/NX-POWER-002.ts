import { ofType, propsOf, referencesLogicalId, scalesToZero, where } from '../cfn';
import { Finding, Rule } from '../types';

const FARGATE_PROVIDERS = ['FARGATE', 'FARGATE_SPOT'];

function isFargate(p: Record<string, unknown>): boolean {
  if (p.LaunchType === 'FARGATE') return true;
  const strategy = Array.isArray(p.CapacityProviderStrategy) ? (p.CapacityProviderStrategy as Record<string, unknown>[]) : [];
  return strategy.some((s) => typeof s?.CapacityProvider === 'string' && FARGATE_PROVIDERS.includes(s.CapacityProvider));
}

/** NX-POWER-002: en dev y stg todo servicio Fargate puede bajar a 0 (un ScalableTarget con MinCapacity 0 o una acción a 0, en el MISMO template). */
export const rule: Rule = {
  id: 'NX-POWER-002',
  title: 'En dev y stg los servicios Fargate bajan a 0',
  severity: 'error',
  appliesTo: ['dev', 'stg'],
  allowsException: true,
  check(app) {
    const findings: Finding[] = [];
    for (const l of ofType(app, 'AWS::ECS::Service')) {
      if (!isFargate(propsOf(l.res))) continue;
      const stackTemplate = app.filter((s) => s.stack === l.stack);
      const targets = ofType(stackTemplate, 'AWS::ApplicationAutoScaling::ScalableTarget').filter((t) => referencesLogicalId(propsOf(t.res).ResourceId, l.id));
      if (targets.some((t) => scalesToZero(propsOf(t.res)))) continue;
      const detail = targets.length
        ? `su ScalableTarget (${targets.map((t) => t.id).join(', ')}) nunca baja a 0 (falta MinCapacity: 0 o una acción programada a 0)`
        : 'no tiene ScalableTarget en el mismo template';
      findings.push({ stack: l.stack, resource: l.id, message: `[NX-POWER-002] ${where(l)}: servicio Fargate que no puede apagarse en dev/stg: ${detail}. Ver docs/rules/NX-POWER-002.md` });
    }
    return findings;
  },
};
