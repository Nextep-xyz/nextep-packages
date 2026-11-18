import { allResources, propsOf, tagMap, where } from '../cfn';
import { Finding, Rule, STAGES } from '../types';

const REQUIRED = ['Project', 'Application', 'Environment'] as const;

/** NX-FIN-001: todo recurso con propiedad `Tags` lleva Project, Application y Environment, y Environment coincide con el stage. */
export const rule: Rule = {
  id: 'NX-FIN-001',
  title: 'Tags de FinOps: Project, Application y Environment',
  severity: 'error',
  appliesTo: ['dev', 'stg', 'prod', 'shared'],
  allowsException: false,
  check(app, ctx) {
    const shared = new Set(ctx.sharedStacks ?? []);
    const findings: Finding[] = [];
    for (const l of allResources(app)) {
      const tags = tagMap(propsOf(l.res));
      if (!tags) continue; // sin propiedad Tags (o Tags intrinsic): no es sujeto de esta regla
      const problems: string[] = [];
      for (const key of REQUIRED) {
        const v = tags[key];
        if (v === undefined || (typeof v === 'string' && v.trim() === '')) {
          const near = Object.keys(tags).find((k) => k !== key && k.toLowerCase() === key.toLowerCase());
          problems.push(near ? `falta ${key} (hay "${near}": las claves de tag distinguen mayúsculas)` : `falta ${key}`);
        }
      }
      const env = tags.Environment;
      if (env !== undefined && !(typeof env === 'string' && env.trim() === '')) {
        const expected = shared.has(l.stack) ? 'shared' : ctx.stage;
        if (typeof env !== 'string') problems.push('Environment debe ser un literal (hoy es un intrinsic)');
        else if (!(STAGES as readonly string[]).includes(env)) problems.push(`Environment "${env}" no es uno de ${STAGES.join(', ')}`);
        else if (env !== expected) {
          problems.push(`Environment "${env}" no coincide con "${expected}" (${shared.has(l.stack) ? 'el stack está en sharedStacks' : `stage de la corrida: ${ctx.stage}`})`);
        }
      }
      if (problems.length) findings.push({ stack: l.stack, resource: l.id, message: `[NX-FIN-001] ${where(l)}: ${problems.join('; ')}. Ver docs/rules/NX-FIN-001.md` });
    }
    return findings;
  },
};
