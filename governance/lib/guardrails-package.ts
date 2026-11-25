// Lógica pura de los gates GR6, GR7 y GR8 (spec cdk-guardrails §3) sobre @nextep/cdk-guardrails.
// El gate (governance/gates/guardrails-package.spec.ts) arma las entradas recorriendo el disco y el tarball; aquí solo se juzga.

export interface SourceFile {
  file: string;
  text: string;
}

/** Quita los comentarios de línea y de bloque: una mención en un comentario no cuenta como uso. Los strings se conservan a propósito. */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const NETWORK_MODULES = 'http|https|http2|net|tls|dgram|dns|child_process|worker_threads|vm';

/** GR6: el motor no usa red ni `eval`/`Function` ni procesos hijos. `exemptFiles` = archivos aislados a propósito (p. ej. el subcomando `preflight`, F6). */
export const FORBIDDEN_IN_SRC: { name: string; re: RegExp }[] = [
  { name: 'módulo de red/procesos', re: new RegExp(`(?:from|require\\()\\s*['"](?:node:)?(?:${NETWORK_MODULES})['"]`) },
  { name: 'fetch()', re: /\bfetch\s*\(/ },
  { name: 'XMLHttpRequest/WebSocket', re: /\b(?:XMLHttpRequest|WebSocket)\b/ },
  { name: 'eval()', re: /\beval\s*\(/ },
  { name: 'Function()', re: /\b(?:new\s+)?Function\s*\(/ },
  { name: 'import() dinámico', re: /\bimport\s*\(/ },
];

export function checkSourceHygiene(files: SourceFile[], exemptFiles: string[] = []): string[] {
  if (files.length === 0) return ['no se descubrió ningún archivo en packages/cdk-guardrails/src: un gate sin sujetos no prueba nada'];
  const problems: string[] = [];
  for (const f of files) {
    if (exemptFiles.includes(f.file)) continue;
    const code = stripComments(f.text);
    for (const { name, re } of FORBIDDEN_IN_SRC) {
      const m = re.exec(code);
      if (m) problems.push(`${f.file}: usa ${name} (${JSON.stringify(m[0])}); el motor no usa red, procesos hijos ni evaluación dinámica`);
    }
  }
  return problems;
}

export interface PackageJson {
  name?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  publishConfig?: { registry?: string } & Record<string, unknown>;
  files?: string[];
  bin?: Record<string, string>;
  [k: string]: unknown;
}

const PEERS = ['aws-cdk-lib', 'constructs'];

/** GR6 (manifiesto) + GR7: cero dependencies de runtime; aws-cdk-lib y constructs SOLO como peerDependencies (dos copias rompen instanceof). */
export function checkManifest(pkg: PackageJson): string[] {
  const p: string[] = [];
  const deps = Object.keys(pkg.dependencies ?? {});
  if (deps.length) p.push(`package.json: "dependencies" debe estar vacío (cero dependencias de runtime); tiene [${deps.join(', ')}]`);
  const opt = Object.keys(pkg.optionalDependencies ?? {});
  if (opt.length) p.push(`package.json: "optionalDependencies" debe estar vacío; tiene [${opt.join(', ')}]`);
  for (const peer of PEERS) {
    if (!pkg.peerDependencies?.[peer]) p.push(`package.json: ${peer} debe declararse en "peerDependencies"`);
    if (pkg.dependencies?.[peer] || pkg.optionalDependencies?.[peer]) p.push(`package.json: ${peer} NO puede ir en "dependencies" (solo peerDependencies)`);
  }
  return p;
}

/** GR8 (manifiesto): sin `publishConfig.registry` (un registry fijado en el manifiesto, cuyo endpoint puede llevar un ID de cuenta, viajaría dentro del tarball) y `files` explícito. */
export function checkPublishConfig(pkg: PackageJson): string[] {
  const p: string[] = [];
  if (pkg.publishConfig && 'registry' in pkg.publishConfig) p.push('package.json: publishConfig.registry está prohibido: el registry lo pasa el workflow de publicación en runtime');
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) p.push('package.json: "files" debe ser una lista explícita (sin ella se empaqueta todo el directorio)');
  else if (pkg.files.some((f) => f === '*' || f === '**' || f === '.' || f === './')) p.push('package.json: "files" no puede ser un comodín del directorio completo');
  return p;
}

/** GR8 (contenido): lo que NO puede viajar en el tarball. */
export const FORBIDDEN_IN_TARBALL: { name: string; re: RegExp }[] = [
  { name: 'un ID de cuenta de AWS (12 dígitos)', re: /(?<![\d.])\d{12}(?![\d.])/ },
  { name: 'un ARN con cuenta', re: /arn:aws[\w-]*:[\w-]*:[\w-]*:\d{12}/ },
  { name: 'un endpoint de AWS (amazonaws.com)', re: /\.amazonaws\.com/ },
  { name: 'publishConfig', re: /publishConfig/ },
];

export function checkTarballContents(files: SourceFile[]): string[] {
  if (files.length === 0) return ['el tarball no tiene archivos: un gate sin sujetos no prueba nada'];
  const p: string[] = [];
  for (const f of files) {
    for (const { name, re } of FORBIDDEN_IN_TARBALL) {
      const m = re.exec(f.text);
      if (m) p.push(`${f.file}: contiene ${name} (${JSON.stringify(m[0])})`);
    }
  }
  return p;
}

/** El tarball debe llevar lo que el consumidor necesita (CLI y código compilado) y NADA de lo que es solo del monorepo. */
export function checkTarballLayout(paths: string[], expectedPresent: string[], expectedAbsentPrefixes: string[]): string[] {
  const p: string[] = [];
  for (const need of expectedPresent) if (!paths.includes(need)) p.push(`el tarball no incluye ${need}`);
  for (const prefix of expectedAbsentPrefixes) {
    for (const f of paths.filter((x) => x.startsWith(prefix))) p.push(`el tarball incluye ${f}, que es solo del monorepo (${prefix})`);
  }
  return p;
}

/**
 * GR-MODE (F0 de cumplimiento-paquetes-por-ambiente): todo adaptador que llama al motor (`evaluate(`) debe pasar su resultado por el modo
 * (`applyMode(` / `applyEnvMode(`). Un adaptador nuevo, escrito por quien no leyó la regla, que evalúe sin pasar por el modo ignoraría
 * `NEXTEP_GUARDRAILS_MODE`: el pipeline lo pondría en `warn` y ese camino seguiría bloqueando (o, peor, el paquete diría que lo honra y no).
 * El archivo que DEFINE `evaluate` (el motor) queda fuera por contenido, no por nombre.
 */
export function checkModeWiring(files: SourceFile[]): string[] {
  const callers = files.filter((f) => /(?<!function\s)\bevaluate\s*\(/.test(stripComments(f.text)) && !/\bfunction\s+evaluate\s*\(/.test(stripComments(f.text)));
  if (callers.length === 0) return ['ningún archivo de src/ llama al motor (evaluate): un gate sin sujetos no prueba nada'];
  return callers
    .filter((f) => !/\b(?:applyMode|applyEnvMode)\s*\(/.test(stripComments(f.text)))
    .map((f) => `${f.file}: llama a evaluate() sin pasar por applyMode()/applyEnvMode(); no honraría NEXTEP_GUARDRAILS_MODE`);
}
