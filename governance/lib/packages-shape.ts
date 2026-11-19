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
/** Licencia de TODO el repo (decision de Q2): permisiva, con descargo de garantia y de responsabilidad, concesion de patentes y sin derecho sobre el nombre. */
export const LICENSE_ID = 'Apache-2.0';
/** sha256 del texto canonico de Apache-2.0 (el original de apache.org, 11358 bytes, LF). El texto legal no se edita: se reemplaza por el original. */
export const LICENSE_SHA256 = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30';
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
  if (m.license !== LICENSE_ID) out.push(`${at}: "license" debe ser "${LICENSE_ID}" (es ${JSON.stringify(m.license)})`);
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

export interface LicenseFacts {
  /** sha256 del LICENSE de la raiz (undefined si no existe). */
  rootLicenseSha?: string;
  /** Contenido del NOTICE de la raiz (undefined si no existe). */
  rootNotice?: string;
  packages: { dir: string; licenseSha?: string; notice?: string }[];
}

/**
 * LICENSE y NOTICE: el de la raiz es el texto canonico; cada paquete lleva una copia identica en SU directorio, porque `npm pack` empaqueta solo
 * el directorio del paquete (sin la copia, el tarball se distribuiria sin licencia).
 */
export function checkLicenseFiles(f: LicenseFacts): string[] {
  const out: string[] = [];
  if (!f.rootLicenseSha) out.push('LICENSE: falta en la raiz del repo');
  else if (f.rootLicenseSha !== LICENSE_SHA256) out.push(`LICENSE: no es el texto canonico de ${LICENSE_ID} (sha256 distinto); no se edita: se reemplaza por el original de apache.org`);
  if (!f.rootNotice) out.push('NOTICE: falta en la raiz del repo');
  else if (!/Copyright \d{4} \S+/.test(f.rootNotice)) out.push('NOTICE: debe llevar una linea "Copyright <anio> <titular>"');
  for (const p of f.packages) {
    if (!p.licenseSha) out.push(`${p.dir}/LICENSE: falta (npm empaqueta solo el directorio del paquete)`);
    else if (p.licenseSha !== f.rootLicenseSha) out.push(`${p.dir}/LICENSE: difiere del LICENSE de la raiz`);
    if (p.notice === undefined) out.push(`${p.dir}/NOTICE: falta`);
    else if (p.notice !== f.rootNotice) out.push(`${p.dir}/NOTICE: difiere del NOTICE de la raiz`);
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
