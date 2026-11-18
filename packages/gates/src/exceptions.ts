import { parse } from 'yaml';

export interface ExceptionEntry {
  id: string;
  guard: string;
  reason: string;
  owner: string;
  expires: string; // YYYY-MM-DD
}
export interface ExceptionMark {
  id: string;
  file: string;
}

/** Sintaxis de la marca en el codigo: `// nextep-exception: <ID>` o `# nextep-exception: <ID>`. */
export const MARK_REGEX = /(?:\/\/|#)\s*nextep-exception:\s*([A-Za-z0-9][A-Za-z0-9_.-]*)/g;

export function scanMarks(file: string, text: string): ExceptionMark[] {
  return [...text.matchAll(MARK_REGEX)].map((m) => ({ id: m[1] as string, file }));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_REASON = 10;

/** Valida la forma del archivo de excepciones (`version: 1` + `exceptions: [...]`). Devuelve los problemas; vacio = valido. */
export function validateExceptionsDoc(doc: unknown, label: string): string[] {
  const p: string[] = [];
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return [`${label}: el documento debe ser un mapa con "version" y "exceptions"`];
  const d = doc as Record<string, unknown>;
  if (d.version !== 1) p.push(`${label}: "version" debe ser 1`);
  if (!Array.isArray(d.exceptions)) return [...p, `${label}: "exceptions" debe ser una lista (puede ser vacia)`];
  d.exceptions.forEach((raw, i) => {
    const e = (raw ?? {}) as Record<string, unknown>;
    const at = `${label}: exceptions[${i}]${typeof e.id === 'string' ? ` (${e.id})` : ''}`;
    for (const k of ['id', 'guard', 'reason', 'owner', 'expires']) {
      if (typeof e[k] !== 'string' || (e[k] as string).trim() === '') p.push(`${at}: falta "${k}"`);
    }
    if (typeof e.reason === 'string' && e.reason.trim().length > 0 && e.reason.trim().length < MIN_REASON) {
      p.push(`${at}: "reason" debe tener al menos ${MIN_REASON} caracteres`);
    }
    if (typeof e.expires === 'string' && !(ISO_DATE.test(e.expires) && !Number.isNaN(Date.parse(e.expires)))) {
      p.push(`${at}: "expires" debe ser una fecha YYYY-MM-DD`);
    }
  });
  return p;
}

/** Parsea el archivo de excepciones. Lanza con TODOS los problemas de forma si no es valido. Una fecha YAML sin comillas se normaliza a YYYY-MM-DD. */
export function parseExceptionsDoc(text: string, label = 'exceptions.yml'): ExceptionEntry[] {
  const doc = parse(text, { schema: 'core' }) as { exceptions?: { expires?: unknown }[] } | null;
  for (const e of doc?.exceptions ?? []) if (e && e.expires instanceof Date) e.expires = e.expires.toISOString().slice(0, 10);
  const problems = validateExceptionsDoc(doc, label);
  if (problems.length) throw new Error(problems.join('\n'));
  return (doc as { exceptions: ExceptionEntry[] }).exceptions;
}

/**
 * Higiene de excepciones: toda excepcion se declara DOS veces (marca en el codigo + entrada con motivo, dueno y caducidad).
 * Devuelve los problemas (vacio = limpio). Una entrada obsoleta o vencida es un problema, igual que una marca huerfana.
 */
export function checkExceptions(entries: ExceptionEntry[], marks: ExceptionMark[], today: Date, label = 'exceptions.yml'): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const e of entries) {
    if (ids.has(e.id)) problems.push(`entrada duplicada en ${label}: ${e.id}`);
    ids.add(e.id);
  }
  const markedIds = new Set(marks.map((m) => m.id));
  for (const m of marks) {
    if (!ids.has(m.id)) problems.push(`${m.file}: marca nextep-exception "${m.id}" sin entrada en ${label}`);
  }
  const todayIso = today.toISOString().slice(0, 10);
  for (const e of entries) {
    if (!markedIds.has(e.id)) problems.push(`${label}: entrada OBSOLETA "${e.id}" (ninguna marca en el codigo); eliminala`);
    if (e.expires < todayIso) problems.push(`${label}: la excepcion "${e.id}" VENCIO el ${e.expires} (hoy ${todayIso})`);
  }
  return problems;
}
