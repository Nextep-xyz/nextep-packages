import { isLit, Located, numberOf, ofType, propsOf, where } from '../cfn';
import { pointsTo } from '../links';
import { Finding, Rule, StackTemplate } from '../types';

/**
 * NX-POWER-005: en prod todo servicio ECS tiene capacidad: `DesiredCount` >= 1 y, si tiene ScalableTarget, `MinCapacity` >= 1 (y ninguna acción
 * programada que lo baje de 1). Complementa NX-POWER-001: aquella prohibe los MECANISMOS de apagado y no admite excepción; esta exige la
 * capacidad mínima y admite excepción. Se solapan en `MinCapacity: 0` a propósito (cada regla es autocontenida) y no se contradicen:
 * NX-POWER-002 (dev/stg deben poder bajar a 0) no aplica en prod.
 */
export const rule: Rule = {
  id: 'NX-POWER-005',
  title: 'En prod todo servicio ECS tiene capacidad mínima de 1',
  severity: 'error',
  appliesTo: ['prod'],
  allowsException: true,
  failsClosed: true,
  check(app: StackTemplate[]) {
    const findings: Finding[] = [];
    const targets = ofType(app, 'AWS::ApplicationAutoScaling::ScalableTarget');

    for (const svc of ofType(app, 'AWS::ECS::Service')) {
      const p = propsOf(svc.res);
      // DesiredCount ausente = 1 (default de ECS; CDK lo omite a propósito cuando hay autoescalado). DAEMON no usa DesiredCount.
      if (p.SchedulingStrategy !== 'DAEMON' && p.DesiredCount !== undefined) {
        const n = numberOf(p.DesiredCount);
        if (n === undefined) {
          findings.push({ stack: svc.stack, resource: svc.id, message: `[NX-POWER-005] ${where(svc)}: no se puede comprobar DesiredCount (no es un literal); debe ser >= 1 en prod. Ver docs/rules/NX-POWER-005.md` });
        } else if (n < 1) {
          findings.push({ stack: svc.stack, resource: svc.id, message: `[NX-POWER-005] ${where(svc)}: DesiredCount es ${n}; en prod debe ser >= 1. Ver docs/rules/NX-POWER-005.md` });
        }
      }
    }

    for (const t of targets) {
      const owners: Located[] = ofType(app, 'AWS::ECS::Service').filter((s) => pointsTo(app, t.stack, propsOf(t.res).ResourceId, s));
      if (owners.length === 0) continue; // no es de un servicio ECS del app
      const p = propsOf(t.res);
      const problems: string[] = [];
      const unknown: string[] = [];
      const min = numberOf(p.MinCapacity);
      if (min === undefined) unknown.push('MinCapacity');
      else if (min < 1) problems.push(`MinCapacity: ${min}`);
      if (p.ScheduledActions !== undefined && !Array.isArray(p.ScheduledActions)) unknown.push('ScheduledActions');
      const actions = Array.isArray(p.ScheduledActions) ? (p.ScheduledActions as unknown[]) : [];
      actions.forEach((a, i) => {
        if (!isLit(a) || (a.ScalableTargetAction !== undefined && !isLit(a.ScalableTargetAction))) {
          unknown.push(`ScheduledActions[${i}]`);
          return;
        }
        const sta = a.ScalableTargetAction;
        if (!isLit(sta) || sta.MinCapacity === undefined) return;
        const m = numberOf(sta.MinCapacity);
        if (m === undefined) unknown.push(`ScheduledActions[${i}].MinCapacity`);
        else if (m < 1) problems.push(`la acción programada ${i} baja MinCapacity a ${m}`);
      });
      if (problems.length || unknown.length) {
        const parts = [
          ...(problems.length ? [`puede dejar el servicio ${owners.map((o) => o.id).join(', ')} sin capacidad en prod (${problems.join('; ')})`] : []),
          ...(unknown.length ? [`no se puede comprobar ${unknown.join(', ')} (no es un literal)`] : []),
        ];
        findings.push({ stack: t.stack, resource: t.id, message: `[NX-POWER-005] ${where(t)}: ${parts.join('; ')}; MinCapacity debe ser >= 1. Ver docs/rules/NX-POWER-005.md` });
      }
    }
    return findings;
  },
};
