import type { ExceptionEntry } from '../types';

/**
 * Lector de governance/exceptions.yml SIN dependencias de runtime (el paquete no arrastra un parser de YAML a cada proyecto).
 * Soporta únicamente el subconjunto que fija el formato de excepciones: `version: 1` y una lista de mapas planos
 * con escalares (planos, 'simples' o "dobles"). Todo lo demás se RECHAZA con la línea, en vez de interpretarse mal en silencio.
 */
const FIELDS = ['id', 'guard', 'reason', 'owner', 'expires'] as const;

function fail(line: number, msg: string): never {
  throw new Error(`exceptions.yml línea ${line}: ${msg}`);
}

/** Quita un comentario `# …` final (solo si el # va precedido de espacio y fuera de comillas). */
function stripComment(raw: string): string {
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] as string;
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(raw[i - 1] as string))) return raw.slice(0, i);
  }
  return raw;
}

function scalar(text: string, line: number): string {
  const t = text.trim();
  if (t.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(t)) fail(line, 'string con comillas dobles mal cerrado');
    return t.slice(1, -1).replace(/\\(.)/g, (_m, ch: string) => ({ n: '\n', t: '\t' } as Record<string, string>)[ch] ?? ch);
  }
  if (t.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(t)) fail(line, "string con comillas simples mal cerrado");
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (t === '' || /^[|>&*!{[]/.test(t)) fail(line, `valor no soportado (${JSON.stringify(t)}): solo escalares planos o entre comillas`);
  return t;
}

export function parseExceptionsYaml(text: string): ExceptionEntry[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  let version: string | undefined;
  let inList = false;
  const entries: Record<string, string>[] = [];
  let current: Record<string, string> | undefined;

  const assign = (target: Record<string, string>, body: string, line: number): void => {
    const m = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(body);
    if (!m) fail(line, `no es «clave: valor» (${JSON.stringify(body)})`);
    const key = m[1] as string;
    if (!(FIELDS as readonly string[]).includes(key)) fail(line, `campo desconocido "${key}" (permitidos: ${FIELDS.join(', ')})`);
    if (key in target) fail(line, `campo duplicado "${key}"`);
    target[key] = scalar(m[2] ?? '', line);
  };

  lines.forEach((raw, i) => {
    const n = i + 1;
    const body = stripComment(raw).trimEnd();
    if (body.trim() === '') return;
    const indent = body.length - body.trimStart().length;
    const t = body.trim();
    if (indent === 0) {
      const m = /^(version|exceptions):(?:\s+(.*))?$/.exec(t);
      if (!m) fail(n, `clave de primer nivel no soportada (${JSON.stringify(t)})`);
      if (m[1] === 'version') version = scalar(m[2] ?? '', n);
      else {
        inList = true;
        if (m[2] !== undefined && m[2].trim() !== '[]') fail(n, 'exceptions debe ser una lista en bloque (o [])');
      }
      return;
    }
    if (!inList) fail(n, 'contenido indentado fuera de exceptions:');
    if (t.startsWith('- ')) {
      current = {};
      entries.push(current);
      assign(current, t.slice(2).trim(), n);
    } else {
      if (!current) fail(n, 'campo fuera de un elemento de lista («- id: …»)');
      assign(current, t, n);
    }
  });

  if (version !== '1') throw new Error(`exceptions.yml: version debe ser 1 (recibido: ${JSON.stringify(version)})`);
  return entries.map((e, i) => {
    const missing = FIELDS.filter((f) => e[f] === undefined);
    if (missing.length) throw new Error(`exceptions.yml: la entrada #${i + 1} (${e.id ?? 'sin id'}) no tiene: ${missing.join(', ')}`);
    if (e.reason!.length < 10) throw new Error(`exceptions.yml: la entrada ${e.id} tiene un reason de menos de 10 caracteres`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.expires!)) throw new Error(`exceptions.yml: la entrada ${e.id} tiene un expires que no es YYYY-MM-DD`);
    return e as unknown as ExceptionEntry;
  });
}
