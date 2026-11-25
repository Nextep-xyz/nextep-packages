import * as fs from 'fs';
import { loadExceptionsFile, loadTemplatesFromDir } from './adapters/load';
import { evaluate } from './engine';
import { applyMode, resolveMode } from './mode';
import { formatGithub,formatStepSummary, formatViolations } from './format';
import { ALL_RULES } from './rules';
import { STAGES, Stage } from './types';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = `uso:
  nextep-guardrails check --out <cdk.out> --stage <dev|stg|prod|shared> [--exceptions <exceptions.yml>] [--shared-stacks <id,id,...>] [--format <text|github>]
  nextep-guardrails --list-rules

Formato: sin --format se autodetecta (github si GITHUB_ACTIONS=true, text si no). github emite anotaciones ::error/::warning; con GITHUB_STEP_SUMMARY definido se anexa una tabla Markdown (en cualquier formato).
Modo: la variable NEXTEP_GUARDRAILS_MODE (enforce por defecto) la fija el pipeline; con warn las violaciones de severidad error se reportan como aviso y no hacen fallar (NX-EXC-00x sigue fallando). Cualquier otro valor se trata como enforce y se avisa.
Códigos de salida: 0 = sin errores (los avisos no cuentan) · 1 = hay violaciones con severidad error · 2 = uso incorrecto o no se pudo evaluar (p. ej. cdk.out sin templates).`;

/** Lee `--clave valor` y `--clave=valor`; devuelve los flags y los argumentos posicionales. */
function parseFlags(args: string[]): { flags: Map<string, string>; rest: string[] } {
  const flags = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (!a.startsWith('--')) {
      rest.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
    else if (a === '--list-rules' || a === '--help') flags.set(a.slice(2), 'true');
    else {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`falta el valor de ${a}`);
      flags.set(a.slice(2), v);
      i++;
    }
  }
  return { flags, rest };
}

/**
 * Anexa la tabla al resumen del run si GITHUB_STEP_SUMMARY existe. Un fallo al escribir es un aviso y NO cambia el código de salida: el resumen
 * es presentación, lo que decide el build es el exit code.
 */
function writeStepSummary(env: Record<string, string | undefined>, markdown: string, io: CliIo): void {
  const file = env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    fs.appendFileSync(file, `${markdown}
`);
  } catch (e) {
    io.err(`nextep-guardrails: aviso: no se pudo escribir GITHUB_STEP_SUMMARY (${(e as Error).message})`);
  }
}

/** CLI (adaptador 3): evalúa un `cdk.out` ya generado, independiente del código del proyecto. Devuelve el código de salida. */
export function main(argv: string[], io: CliIo = { out: (l) => console.log(l), err: (l) => console.error(l) }, now?: Date, env: Record<string, string | undefined> = process.env): number {
  try {
    const { flags, rest } = parseFlags(argv);
    if (flags.has('help')) {
      io.out(USAGE);
      return 0;
    }
    if (flags.has('list-rules')) {
      for (const r of ALL_RULES) io.out(`${r.id}  ${r.severity.padEnd(5)}  stages=${r.appliesTo.join(',')}  excepción=${r.allowsException ? 'sí' : 'no'}  ${r.title}`);
      return 0;
    }
    if (rest[0] !== 'check' || rest.length !== 1) throw new Error(`comando desconocido o ausente (${JSON.stringify(rest.join(' '))})`);
    const known = ['out', 'stage', 'exceptions', 'shared-stacks', 'format'];
    for (const k of flags.keys()) if (!known.includes(k)) throw new Error(`opción desconocida --${k} (no existe forma de desactivar una regla)`);
    const out = flags.get('out');
    const stage = flags.get('stage');
    if (!out) throw new Error('falta --out <directorio de cdk.out>');
    if (!stage || !(STAGES as readonly string[]).includes(stage)) throw new Error(`--stage debe ser uno de ${STAGES.join(', ')} (recibido: ${JSON.stringify(stage)})`);

    const requested = flags.get('format');
    if (requested !== undefined && requested !== 'text' && requested !== 'github') throw new Error(`--format debe ser text o github (recibido: ${JSON.stringify(requested)})`);
    // Sin --format: github dentro de GitHub Actions (el consumidor no controla los flags de la CLI que llama su pipeline), text fuera.
    const format = requested ?? (env.GITHUB_ACTIONS === 'true' ? 'github' : 'text');

    const templates = loadTemplatesFromDir(out);
    const exceptions = flags.has('exceptions') ? loadExceptionsFile(flags.get('exceptions') as string) : [];
    const sharedStacks = flags.get('shared-stacks')?.split(',').map((s) => s.trim()).filter(Boolean);
    const { mode, invalid } = resolveMode(env);
    if (invalid) io.err(`nextep-guardrails: aviso: ${invalid}`);
    const violations = applyMode(evaluate(templates, { stage: stage as Stage, sharedStacks, exceptions, now }), mode);
    io.out(format === 'github' ? formatGithub(violations, stage) : formatViolations(violations, stage));
    writeStepSummary(env, formatStepSummary(violations, stage, mode), io);
    return violations.some((v) => v.severity === 'error') ? 1 : 0;
  } catch (e) {
    io.err(`nextep-guardrails: ${(e as Error).message}`);
    io.err(USAGE);
    return 2;
  }
}
