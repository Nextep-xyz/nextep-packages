import { ofType, propsOf, numberOf, scalesToZero, where } from '../cfn';
import { actionKey, schedules } from '../schedules';
import { Finding, Rule } from '../types';

/** Acciones universales de Scheduler que apagan algo (en minúsculas; ver `actionKey`). */
const SHUTDOWN = new Set(['rds:stopdbinstance', 'rds:stopdbcluster', 'ec2:stopinstances', 'ecs:updateservice']);

/**
 * NX-POWER-001: en prod no existe ningún apagado. Ni un schedule con target de apagado, ni un ScalableTarget que pueda dejar el
 * servicio en 0. NO admite excepción (decisión de diseño): un prod que se apaga es una caída programada.
 */
export const rule: Rule = {
  id: 'NX-POWER-001',
  title: 'En prod no existe ningún apagado',
  severity: 'error',
  appliesTo: ['prod'],
  allowsException: false,
  check(app) {
    const findings: Finding[] = [];
    for (const s of schedules(app)) {
      if (!s.target) continue; // no es un target universal: no se juzga
      if (!s.target.complete) {
        findings.push({
          stack: s.loc.stack,
          resource: s.loc.id,
          message: `[NX-POWER-001] ${where(s.loc)}: target universal de Scheduler cuya acción no se puede resolver; no se puede comprobar que no apague prod. Ver docs/rules/NX-POWER-001.md`,
        });
      } else if (SHUTDOWN.has(actionKey(s.target))) {
        findings.push({
          stack: s.loc.stack,
          resource: s.loc.id,
          message: `[NX-POWER-001] ${where(s.loc)}: apagado programado (${s.target.service}:${s.target.action}) en prod. Ver docs/rules/NX-POWER-001.md`,
        });
      }
    }
    for (const l of ofType(app, 'AWS::ApplicationAutoScaling::ScalableTarget')) {
      const p = propsOf(l.res);
      if (!scalesToZero(p)) continue;
      const why = numberOf(p.MinCapacity) === 0 ? 'MinCapacity: 0' : 'una acción programada con MaxCapacity: 0';
      findings.push({ stack: l.stack, resource: l.id, message: `[NX-POWER-001] ${where(l)}: puede dejar el servicio en 0 en prod (${why}). Ver docs/rules/NX-POWER-001.md` });
    }
    return findings;
  },
};
