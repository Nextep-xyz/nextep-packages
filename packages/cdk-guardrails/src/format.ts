import type { Violation } from './types';

/** Texto de un reporte: una línea por violación (el mensaje ya nombra regla, stack y recurso) y un resumen. */
export function formatViolations(violations: Violation[], stage: string): string {
  const errors = violations.filter((v) => v.severity === 'error').length;
  const warns = violations.length - errors;
  const stacks = new Set(violations.map((v) => v.stack)).size;
  const lines = violations.map((v) => `${v.severity === 'error' ? 'ERROR' : 'WARN '} ${v.message}`);
  lines.push(`nextep-guardrails: ${errors} error(es), ${warns} aviso(s) en ${stacks} stack(s) (stage=${stage})`);
  return lines.join('\n');
}
