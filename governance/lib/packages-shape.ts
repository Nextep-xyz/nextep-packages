// Logica pura del gate de forma de los paquetes (spec nextep-packages, guards G-PKG-*): lo que TODO paquete de packages/* debe cumplir.
// El gate (governance/gates/packages-shape.spec.ts) descubre los paquetes por disco y arma las entradas; aqui solo se juzga.

export interface PackageManifest {
  name?: string;
  version?: string;
  private?: boolean;
  license?: string;
  description?: string;
  main?: string;
  types?: string;
  bin?: Record<string, string> | string;
  files?: string[];
  engines?: { node?: string };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  publishConfig?: Record<string, unknown>;
  [k: string]: unknown;
}

export const SCOPE = '@nextep/';
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const FLOATING = /^(\^|~|\*|latest|next|>|<)/;

export interface PackageFacts {
  /** Ruta del directorio, relativa a la raiz (p. ej. `packages/gates`). */
  dir: string;
  manifest: PackageManifest;
  hasReadme: boolean;
  hasBuildConfig: boolean;
}

/** Binarios declarados, como lista de rutas. */
export function binPaths(m: PackageManifest): string[] {
  if (!m.bin) return [];
  return typeof m.bin === 'string' ? [m.bin] : Object.values(m.bin);
}

export function checkPackageShape(p: PackageFacts): string[] {
  const m = p.manifest;
  const at = `${p.dir}/package.json`;
  const out: string[] = [];
  if (!m.name?.startsWith(SCOPE)) out.push(`${at}: "name" debe empezar por ${SCOPE} (es ${JSON.stringify(m.name)})`);
  if (m.name && p.dir.split('/').pop() !== m.name.slice(SCOPE.length) && m.name.startsWith(SCOPE)) {
    out.push(`${at}: el directorio (${p.dir.split('/').pop()}) debe coincidir con el nombre sin scope (${m.name.slice(SCOPE.length)})`);
  }
  if (!m.version || !EXACT_VERSION.test(m.version)) out.push(`${at}: "version" debe ser semver exacto (es ${JSON.stringify(m.version)})`);
  // Nada se publica en un registry de npm: se distribuye como tarball de un GitHub Release. `private: true` hace que un `npm publish`
  // accidental falle; `npm pack` y la instalacion por URL del tarball siguen funcionando.
  if (m.private !== true) out.push(`${at}: debe declarar "private": true (el paquete se distribuye por Release, nunca por npm publish)`);
  if (!m.license) out.push(`${at}: falta "license" (UNLICENSED si no hay licencia explicita)`);
  if (!m.description) out.push(`${at}: falta "description"`);
  if (!m.engines?.node) out.push(`${at}: falta "engines.node"`);
  if (!m.main || !m.types) out.push(`${at}: faltan "main" y "types" (el consumidor usa el codigo compilado)`);
  if (m.publishConfig) out.push(`${at}: "publishConfig" esta prohibido (no hay registry; ademas un registry fijado viajaria dentro del tarball)`);
  if (!Array.isArray(m.files) || m.files.length === 0) out.push(`${at}: "files" debe ser una lista explicita (sin ella se empaqueta todo el directorio)`);
  else if (m.files.some((f) => ['*', '**', '.', './'].includes(f))) out.push(`${at}: "files" no puede ser un comodin del directorio completo`);
  if (!m.scripts?.build || !m.scripts?.prepack) out.push(`${at}: faltan los scripts "build" y "prepack" (el tarball debe llevar dist/ compilado)`);
  if (!p.hasBuildConfig) out.push(`${p.dir}/tsconfig.build.json: falta (lo usan "build" y "prepack")`);
  if (!p.hasReadme) out.push(`${p.dir}/README.md: falta`);

  // Las dependencias de runtime van fijadas y NUNCA hacia otro paquete del workspace (el tarball no lo resolveria).
  for (const section of ['dependencies', 'optionalDependencies'] as const) {
    for (const [dep, range] of Object.entries(m[section] ?? {})) {
      if (range.startsWith('workspace:') || range.startsWith('file:') || range.startsWith('link:')) {
        out.push(`${at}: ${section}.${dep} = ${range}: un enlace local no sobrevive al tarball`);
      } else if (FLOATING.test(range)) {
        out.push(`${at}: ${section}.${dep} = ${range}: version flotante; fija una version exacta`);
      }
    }
  }
  return out;
}

/** Entre paquetes no puede haber dos con el mismo nombre. */
export function checkUniqueNames(all: PackageFacts[]): string[] {
  const seen = new Map<string, string>();
  const out: string[] = [];
  for (const p of all) {
    const n = p.manifest.name ?? '';
    const prev = seen.get(n);
    if (prev) out.push(`${p.dir}/package.json: el nombre ${n} ya lo usa ${prev}`);
    else seen.set(n, p.dir);
  }
  return out;
}
