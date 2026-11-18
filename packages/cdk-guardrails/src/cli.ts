import { loadExceptionsFile, loadTemplatesFromDir } from './adapters/load';
import { evaluate } from './engine';
import { formatViolations } from './format';
import { ALL_RULES } from './rules';
import { STAGES, Stage } from './types';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = `uso:
  nextep-guardrails check --out <cdk.out> --stage <dev|stg|prod|shared> [--exceptions <exceptions.yml>] [--shared-stacks <id,id,...>]
  nextep-guardrails --list-rules

Códigos de salida: 0 = sin errores · 1 = hay violaciones con severidad error · 2 = uso incorrecto o no se pudo evaluar (p. ej. cdk.out sin templates).`;

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

/** CLI (adaptador 3): evalúa un `cdk.out` ya generado, independiente del código del proyecto. Devuelve el código de salida. */
export function main(argv: string[], io: CliIo = { out: (l) => console.log(l), err: (l) => console.error(l) }, now?: Date): number {
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
    const known = ['out', 'stage', 'exceptions', 'shared-stacks'];
    for (const k of flags.keys()) if (!known.includes(k)) throw new Error(`opción desconocida --${k} (no existe forma de desactivar una regla)`);
    const out = flags.get('out');
    const stage = flags.get('stage');
    if (!out) throw new Error('falta --out <directorio de cdk.out>');
    if (!stage || !(STAGES as readonly string[]).includes(stage)) throw new Error(`--stage debe ser uno de ${STAGES.join(', ')} (recibido: ${JSON.stringify(stage)})`);

    const templates = loadTemplatesFromDir(out);
    const exceptions = flags.has('exceptions') ? loadExceptionsFile(flags.get('exceptions') as string) : [];
    const sharedStacks = flags.get('shared-stacks')?.split(',').map((s) => s.trim()).filter(Boolean);
    const violations = evaluate(templates, { stage: stage as Stage, sharedStacks, exceptions, now });
    io.out(formatViolations(violations, stage));
    return violations.some((v) => v.severity === 'error') ? 1 : 0;
  } catch (e) {
    io.err(`nextep-guardrails: ${(e as Error).message}`);
    io.err(USAGE);
    return 2;
  }
}
