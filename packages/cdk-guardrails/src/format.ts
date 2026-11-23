import type { Violation } from './types';

function counts(violations: Violation[]): { errors: number; warns: number; stacks: number } {
  const errors = violations.filter((v) => v.severity === 'error').length;
  return { errors, warns: violations.length - errors, stacks: new Set(violations.map((v) => v.stack)).size };
}

const summaryLine = (violations: Violation[], stage: string): string => {
  const { errors, warns, stacks } = counts(violations);
  return `nextep-guardrails: ${errors} error(es), ${warns} aviso(s) en ${stacks} stack(s) (stage=${stage})`;
};

/** Texto de un reporte: una línea por violación (el mensaje ya nombra regla, stack y recurso) y un resumen. */
export function formatViolations(violations: Violation[], stage: string): string {
  const lines = violations.map((v) => `${v.severity === 'error' ? 'ERROR' : 'WARN '} ${v.message}`);
  lines.push(summaryLine(violations, stage));
  return lines.join('\n');
}

/** Escape del MENSAJE de un comando de workflow de GitHub Actions: sin él, un salto de línea en un nombre de recurso inyectaría otro comando. */
export const escapeCommandData = (s: string): string => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
/** Escape de una PROPIEDAD de un comando de workflow (además de lo anterior, `:` y `,` delimitan). */
export const escapeCommandProperty = (s: string): string => escapeCommandData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

/**
 * Formato `github`: una anotación por violación (`::error title=<regla>::<mensaje>` o `::warning …`) más la línea resumen. Las `warn` salen como
 * `::warning` (amarillo en el resumen del run) y no cambian el código de salida. GitHub muestra como máximo 10 anotaciones de cada tipo por
 * step: el listado completo va en la tabla de `GITHUB_STEP_SUMMARY` (`formatStepSummary`).
 */
export function formatGithub(violations: Violation[], stage: string): string {
  const lines = violations.map((v) => `::${v.severity === 'error' ? 'error' : 'warning'} title=${escapeCommandProperty(v.ruleId)}::${escapeCommandData(v.message)}`);
  lines.push(summaryLine(violations, stage));
  return lines.join('\n');
}

/** Una celda de tabla Markdown: sin pipes ni saltos de línea ni HTML que rompan la tabla o se rendericen. */
export const escapeCell = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Sección Markdown para `GITHUB_STEP_SUMMARY`: conteos y una tabla con TODAS las violaciones (errores primero). */
export function formatStepSummary(violations: Violation[], stage: string): string {
  const { errors, warns } = counts(violations);
  const out = [`### nextep-guardrails · stage \`${stage}\``, ''];
  if (violations.length === 0) {
    out.push('Sin violaciones.', '');
    return out.join('\n');
  }
  out.push(`**${errors} error(es)** y **${warns} aviso(s)**.`, '', '| Severidad | Regla | Stack | Recurso | Mensaje |', '|---|---|---|---|---|');
  const ordered = [...violations].sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'));
  for (const v of ordered) {
    out.push(`| ${v.severity === 'error' ? 'error' : 'aviso'} | \`${escapeCell(v.ruleId)}\` | \`${escapeCell(v.stack)}\` | \`${escapeCell(v.resource ?? '')}\` | ${escapeCell(v.message)} |`);
  }
  out.push('');
  return out.join('\n');
}
