import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import fg from 'fast-glob';

/**
 * Escaner de higiene para repos PUBLICOS. Mismos detectores que el gate G13 de nextep-platform-workflows (scan-public.sh):
 * ID de cuenta de 12 digitos, ARN con cuenta literal, correo fuera de @example.*, IP privada, URL fuera de la allowlist
 * y nombres internos de una denylist. Nunca imprime ni devuelve el valor encontrado, solo archivo:linea:detector.
 *
 * La denylist NO vive en el repo (listarla aqui filtraria justo los nombres que se quieren proteger): llega por entorno
 * (`INTERNAL_DENYLIST`, un secreto de la organizacion en CI).
 */
export interface Finding {
  file: string;
  line: number;
  detector: string;
}

export interface PublicScanOptions {
  /** Raiz del repo a escanear. Si es la raiz de un repo git, se escanean los archivos versionados o no ignorados. */
  root: string;
  /** Nombres internos prohibidos (insensible a mayusculas, texto literal). Vacio = solo los detectores genericos. */
  denylist?: string[];
  /** Si la denylist esta vacia, lanzar en vez de escanear a medias (CI: el gate no puede avalar nombres internos sin lista). */
  requireDenylist?: boolean;
  /** Regex (string) de hosts permitidos en URLs; se comparan contra el host completo. Reemplaza los defaults. */
  allowedHosts?: string[];
  /**
   * Rutas exactas (relativas a `root`) de archivos GENERADOS con metadata de terceros, p. ej. el lockfile (correos de autores, nombres de
   * mantenedores). Cada exclusion debe justificarse en quien llama. Una ruta que no existe lanza: una exclusion obsoleta es una excepcion
   * que nadie revisa.
   */
  ignoreFiles?: string[];
}

export interface PublicScanResult {
  findings: Finding[];
  scanned: number;
  denylistActive: boolean;
}

export const DEFAULT_ALLOWED_HOSTS: readonly string[] = [
  'github\\.com',
  '.*\\.github\\.com',
  '.*\\.githubusercontent\\.com',
  '.*\\.amazonaws\\.com',
  '.*\\.amazon\\.com',
  '.*\\.npmjs\\.(com|org)',
  'npmjs\\.(com|org)',
  'nodejs\\.org',
  'json-schema\\.org',
  'localhost',
  '.*\\.example\\.[a-z]+',
  'example\\.[a-z]+',
];

/** `INTERNAL_DENYLIST` admite comas o saltos de linea. */
export function parseDenylist(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[,\n\r]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const IGNORED_DIRS = ['**/node_modules/**', '**/.git/**', '**/cdk.out/**', '**/dist/**'];

function listFiles(root: string): string[] {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
  const isRepoRoot = top.status === 0 && path.resolve(top.stdout.trim()) === path.resolve(root);
  if (isRepoRoot) {
    const ls = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    if (ls.status === 0) return ls.stdout.toString('utf8').split('\0').filter((f) => f.length > 0 && fs.existsSync(path.join(root, f)));
  }
  return fg.sync('**/*', { cwd: root, onlyFiles: true, dot: true, ignore: IGNORED_DIRS });
}

const isText = (buf: Buffer): boolean => buf.length > 0 && !buf.subarray(0, 8000).includes(0);

const ACCOUNT_RE = /(^|[^0-9A-Za-z])[0-9]{12}([^0-9A-Za-z]|$)/;
const ARN_RE = /arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:[0-9]{12}:/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const EXAMPLE_EMAIL_RE = /@example\.[a-z]+$/;
const IP_RE = /(^|[^0-9.])(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3})([^0-9]|$)/;
const URL_RE = /https?:\/\/[^\s]+/g;

function hostOf(url: string): string {
  const afterScheme = url.slice(url.indexOf('://') + 3);
  return afterScheme.split(/[/:?#"')> \\]/)[0] ?? '';
}

/** Un host que parece plantilla o regex (p. ej. el patron de un JSON Schema) no es un host. */
const isPlaceholderHost = (h: string): boolean => h === '' || /[<${%]/.test(h) || /^[[(^*]/.test(h);

export function scanPublic(opts: PublicScanOptions): PublicScanResult {
  const denylist = (opts.denylist ?? []).filter((d) => d.length > 0).map((d) => d.toLowerCase());
  if (denylist.length === 0 && opts.requireDenylist) {
    throw new Error('scanPublic: INTERNAL_DENYLIST no esta configurada; el gate no puede avalar que no haya nombres internos');
  }
  const allowed = (opts.allowedHosts ?? [...DEFAULT_ALLOWED_HOSTS]).map((p) => new RegExp(`^${p}$`));
  const all = listFiles(opts.root).map((f) => f.replace(/\\/g, '/'));
  const ignored = new Set(opts.ignoreFiles ?? []);
  for (const i of ignored) {
    if (!all.includes(i)) throw new Error(`scanPublic: ignoreFiles incluye "${i}", que no existe entre los archivos escaneables; elimina la exclusion obsoleta`);
  }
  const files = all.filter((f) => !ignored.has(f));
  if (files.length === 0) throw new Error(`scanPublic: 0 archivos por escanear en ${opts.root} (un gate que no encuentra nada no prueba nada)`);

  const findings: Finding[] = [];
  let scanned = 0;
  for (const file of files) {
    const buf = fs.readFileSync(path.join(opts.root, file));
    if (!isText(buf)) continue;
    scanned++;
    const lines = buf.toString('utf8').split(/\r?\n/);
    lines.forEach((text, i) => {
      const line = i + 1;
      const hit = (detector: string): void => void findings.push({ file: file.replace(/\\/g, '/'), line, detector });
      if (ACCOUNT_RE.test(text)) hit('12-digit cloud account id');
      if (ARN_RE.test(text)) hit('arn with a literal account id');
      for (const email of text.match(EMAIL_RE) ?? []) if (!EXAMPLE_EMAIL_RE.test(email)) hit('email address');
      if (IP_RE.test(text)) hit('private IP address');
      for (const url of text.match(URL_RE) ?? []) {
        const host = hostOf(url);
        if (isPlaceholderHost(host)) continue;
        if (!allowed.some((re) => re.test(host))) hit('URL host outside the public allowlist');
      }
      if (denylist.length > 0) {
        const lower = text.toLowerCase();
        if (denylist.some((d) => lower.includes(d))) hit('internal name from INTERNAL_DENYLIST');
      }
    });
  }
  if (scanned === 0) throw new Error(`scanPublic: ${files.length} archivos pero ninguno es texto; el gate no probo nada`);
  return { findings, scanned, denylistActive: denylist.length > 0 };
}

/** Formatea los hallazgos como `archivo:linea: detector`, sin el valor. */
export function formatFindings(findings: Finding[]): string {
  return findings.map((f) => `${f.file}:${f.line}: ${f.detector}`).join('\n');
}
