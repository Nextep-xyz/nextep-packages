import type { GuardrailsContext, Rule, StackTemplate, Violation } from '../types';
import { EXCEPTION_METADATA_KEY, isActive, markIds } from './model';

/**
 * Ids de higiene de las excepciones (spec §2.4, GR5). No son reglas del catálogo (no viven en src/rules/): son lo que el motor
 * dice cuando la declaración doble está rota. Congelados junto con los demás ids (spec I2).
 */
export const EXC = {
  /** Una marca `nextep:exception` sin entrada en governance/exceptions.yml (o de una regla que no existe). */
  MARK_WITHOUT_ENTRY: 'NX-EXC-001',
  /** Una entrada sin marca en ningún recurso (obsoleta), o de una regla que no existe. */
  ENTRY_WITHOUT_MARK: 'NX-EXC-002',
  /** Una entrada vencida. */
  EXPIRED: 'NX-EXC-003',
  /** Una marca o una entrada sobre una regla que no admite excepción. */
  NOT_ALLOWED: 'NX-EXC-004',
} as const;

/** Las entradas de exceptions.yml de un proyecto no son todas de este motor: solo las de `guard: NX-…` se juzgan aquí. */
const isOurs = (guard: string): boolean => guard.startsWith('NX-');

/** Dónde se reporta lo que no vive en un template (una entrada de exceptions.yml). */
export const EXCEPTIONS_FILE = 'governance/exceptions.yml';

interface Mark {
  stack: string;
  resource: string;
  ruleId: string;
}

export function checkExceptions(app: StackTemplate[], ctx: GuardrailsContext, rules: readonly Rule[], now: Date): Violation[] {
  const out: Violation[] = [];
  const known = new Map(rules.map((r) => [r.id, r]));
  const v = (ruleId: string, stack: string, resource: string, message: string): void => {
    out.push({ ruleId, severity: 'error', stack, resource, message });
  };

  const marks: Mark[] = app.flatMap((s) =>
    Object.entries(s.template.Resources ?? {}).flatMap(([id, res]) => markIds(res.Metadata?.[EXCEPTION_METADATA_KEY]).map((ruleId) => ({ stack: s.stack, resource: id, ruleId }))),
  );
  const entries = ctx.exceptions.filter((e) => isOurs(e.guard));

  for (const m of marks) {
    const where = `${m.stack}/${m.resource}`;
    const rule = known.get(m.ruleId);
    if (!rule) {
      v(EXC.MARK_WITHOUT_ENTRY, m.stack, m.resource, `[${EXC.MARK_WITHOUT_ENTRY}] ${where}: la marca ${EXCEPTION_METADATA_KEY} nombra "${m.ruleId}", que no es una regla del catálogo. Ver docs/exceptions.md`);
    } else if (!rule.allowsException) {
      v(EXC.NOT_ALLOWED, m.stack, m.resource, `[${EXC.NOT_ALLOWED}] ${where}: ${m.ruleId} no admite excepción; quite la marca y corrija el recurso. Ver docs/exceptions.md`);
    } else if (!entries.some((e) => e.guard === m.ruleId)) {
      v(EXC.MARK_WITHOUT_ENTRY, m.stack, m.resource, `[${EXC.MARK_WITHOUT_ENTRY}] ${where}: marca de excepción para ${m.ruleId} sin entrada (guard: ${m.ruleId}) en ${EXCEPTIONS_FILE}. Ver docs/exceptions.md`);
    }
  }

  for (const e of entries) {
    const rule = known.get(e.guard);
    if (!rule) {
      v(EXC.ENTRY_WITHOUT_MARK, EXCEPTIONS_FILE, e.id, `[${EXC.ENTRY_WITHOUT_MARK}] ${EXCEPTIONS_FILE}/${e.id}: guard "${e.guard}" no es una regla del catálogo. Ver docs/exceptions.md`);
      continue;
    }
    if (!rule.allowsException) {
      v(EXC.NOT_ALLOWED, EXCEPTIONS_FILE, e.id, `[${EXC.NOT_ALLOWED}] ${EXCEPTIONS_FILE}/${e.id}: ${e.guard} no admite excepción; la entrada no puede existir. Ver docs/exceptions.md`);
      continue;
    }
    if (!isActive(e, now)) {
      v(EXC.EXPIRED, EXCEPTIONS_FILE, e.id, `[${EXC.EXPIRED}] ${EXCEPTIONS_FILE}/${e.id}: la excepción de ${e.guard} venció el ${e.expires} (owner: ${e.owner}); renuévela con motivo o corrija el recurso. Ver docs/exceptions.md`);
    }
    if (!marks.some((m) => m.ruleId === e.guard)) {
      v(EXC.ENTRY_WITHOUT_MARK, EXCEPTIONS_FILE, e.id, `[${EXC.ENTRY_WITHOUT_MARK}] ${EXCEPTIONS_FILE}/${e.id}: entrada OBSOLETA de ${e.guard}: ningún recurso lleva la marca ${EXCEPTION_METADATA_KEY}. Bórrela. Ver docs/exceptions.md`);
    }
  }
  return out;
}
