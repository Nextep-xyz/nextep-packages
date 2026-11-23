import { EXCEPTION_METADATA_KEY, isActive, markIds } from './exceptions/model';
import { checkExceptions } from './exceptions/verify';
import { ALL_RULES } from './rules';
import { ExceptionEntry, Finding, GuardrailsContext, Rule, StackTemplate, STAGES, Violation } from './types';

const CONTEXT_KEYS = ['stage', 'sharedStacks', 'exceptions', 'now'];
const ENTRY_FIELDS: (keyof ExceptionEntry)[] = ['id', 'guard', 'reason', 'owner', 'expires'];

/**
 * Valida el contexto. No existe ninguna opción para desactivar una regla (spec §2.2, GR4): un campo que el motor no conoce
 * se rechaza en vez de ignorarse, para que `{ skip: ['NX-COST-001'] }` no parezca funcionar.
 */
function assertContext(ctx: GuardrailsContext): void {
  const extra = Object.keys(ctx).filter((k) => !CONTEXT_KEYS.includes(k));
  if (extra.length) {
    throw new Error(
      `GuardrailsContext: campo(s) ${extra.map((k) => `"${k}"`).join(', ')} no permitido(s). Campos válidos: ${CONTEXT_KEYS.join(', ')}. ` +
        'No existe forma de desactivar una regla: solo excepciones declaradas dos veces (marca en el recurso + entrada en governance/exceptions.yml).',
    );
  }
  if (!(STAGES as readonly string[]).includes(ctx.stage)) {
    throw new Error(`GuardrailsContext: stage inválido (${JSON.stringify(ctx.stage)}); debe ser uno de ${STAGES.join(', ')}. El stage no se adivina por el nombre del stack.`);
  }
  if (ctx.sharedStacks !== undefined && !(Array.isArray(ctx.sharedStacks) && ctx.sharedStacks.every((s) => typeof s === 'string'))) {
    throw new Error('GuardrailsContext: sharedStacks debe ser una lista de ids de stack (strings).');
  }
  if (!Array.isArray(ctx.exceptions)) throw new Error('GuardrailsContext: exceptions debe ser una lista (puede ir vacía).');
  ctx.exceptions.forEach((e, i) => {
    const bad = ENTRY_FIELDS.filter((f) => typeof (e as unknown as Record<string, unknown>)?.[f] !== 'string');
    if (bad.length) throw new Error(`GuardrailsContext: exceptions[${i}] mal formada; falta(n) o no es(son) string: ${bad.join(', ')}.`);
  });
  if (ctx.now !== undefined && !(ctx.now instanceof Date && !Number.isNaN(ctx.now.getTime()))) {
    throw new Error('GuardrailsContext: now debe ser una Date válida.');
  }
}

/**
 * Una violación se silencia solo si la regla admite excepción, el recurso lleva la marca de ESA regla y existe una entrada
 * vigente con `guard` = id de la regla. Sin ambas mitades la violación se reporta, y checkExceptions agrega la violación de higiene
 * (marca sin entrada, entrada sin marca, vencida, regla que no admite excepción: NX-EXC-00x).
 */
function isExcepted(rule: Rule, f: Finding, app: StackTemplate[], ctx: GuardrailsContext, now: Date): boolean {
  // `f.exceptable === false` restringe un hallazgo concreto de una regla que sí admite excepción; nunca la amplía.
  if (!rule.allowsException || f.exceptable === false || f.resource === undefined) return false;
  const res = app.find((s) => s.stack === f.stack)?.template.Resources?.[f.resource];
  if (!markIds(res?.Metadata?.[EXCEPTION_METADATA_KEY]).includes(rule.id)) return false;
  return ctx.exceptions.some((e) => e.guard === rule.id && isActive(e, now));
}

/**
 * El motor: función pura `evaluate(templates, context) → Violation[]`. Sin red, sin fs y sin aws-cdk-lib: lee el JSON que AWS
 * recibe de verdad. `rules` es inyectable solo para probar el motor; los adaptadores usan el catálogo completo.
 */
export function evaluate(templates: StackTemplate[], context: GuardrailsContext, rules: readonly Rule[] = ALL_RULES): Violation[] {
  assertContext(context);
  const now = context.now ?? new Date();
  const out: Violation[] = [];
  for (const rule of rules) {
    if (!rule.appliesTo.includes(context.stage)) continue;
    for (const f of rule.check(templates, context)) {
      if (isExcepted(rule, f, templates, context, now)) continue;
      out.push({ ruleId: rule.id, severity: rule.severity, stack: f.stack, resource: f.resource, message: f.message });
    }
  }
  out.push(...checkExceptions(templates, context, rules, now));
  return out.sort((a, b) => a.stack.localeCompare(b.stack) || (a.resource ?? '').localeCompare(b.resource ?? '') || a.ruleId.localeCompare(b.ruleId));
}
