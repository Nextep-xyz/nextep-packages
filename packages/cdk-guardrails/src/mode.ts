import { EXC } from './exceptions/verify';
import type { Violation } from './types';

/** Variable de entorno con la que el pipeline decide el modo del paquete. No existe opción equivalente en código ni en flags de la CLI (spec cumplimiento-paquetes-por-ambiente §2.8). */
export const MODE_ENV = 'NEXTEP_GUARDRAILS_MODE';

export type GuardrailsMode = 'enforce' | 'warn';

export interface ResolvedMode {
  mode: GuardrailsMode;
  /** Presente solo si la variable traía un valor que no es `enforce` ni `warn`: el modo efectivo es `enforce` y este es el aviso para el usuario. */
  invalid?: string;
}

/**
 * Único lugar que interpreta `NEXTEP_GUARDRAILS_MODE`. Fail-closed: solo el valor exacto `warn` relaja; ausente, vacío o `enforce` es `enforce`
 * (sin aviso: una variable vacía es «no definida» en un pipeline) y cualquier otro valor es `enforce` con aviso, para que un typo (`Warn`, `warn `)
 * no pase por un modo que no es.
 */
export function resolveMode(env: Record<string, string | undefined> = process.env): ResolvedMode {
  const raw = env[MODE_ENV];
  if (raw === undefined || raw === '' || raw === 'enforce') return { mode: 'enforce' };
  if (raw === 'warn') return { mode: 'warn' };
  return { mode: 'enforce', invalid: `${MODE_ENV}=${JSON.stringify(raw)} no es un modo válido (enforce|warn); se aplica enforce.` };
}

/** Las violaciones de higiene de excepciones (NX-EXC-001..004) son defectos de gobierno, no de costo: ningún modo las relaja. */
const NEVER_DOWNGRADED: readonly string[] = Object.values(EXC);

/**
 * Aplica el modo a las violaciones que devuelve el motor. `enforce` no toca nada. `warn` reclasifica `error` → `warn` y lo marca con
 * `downgraded` para que los adaptadores lo muestren como «degradado»; NX-EXC-00x queda como `error`. No cambia reglas ni severidades del catálogo.
 */
export function applyMode(violations: Violation[], mode: GuardrailsMode): Violation[] {
  if (mode === 'enforce') return violations;
  return violations.map((v) => (v.severity === 'error' && !NEVER_DOWNGRADED.includes(v.ruleId) ? { ...v, severity: 'warn', downgraded: true } : v));
}

/** Resuelve el modo, avisa por `warn` si el valor era inválido y devuelve las violaciones ya reclasificadas. `warn` recibe el canal de cada adaptador (stderr, `io.err`). */
export function applyEnvMode(violations: Violation[], env: Record<string, string | undefined>, warn: (line: string) => void): Violation[] {
  const { mode, invalid } = resolveMode(env);
  if (invalid) warn(`nextep-guardrails: aviso: ${invalid}`);
  return applyMode(violations, mode);
}
