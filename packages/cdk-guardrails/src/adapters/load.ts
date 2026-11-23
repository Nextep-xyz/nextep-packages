import * as fs from 'fs';
import * as path from 'path';
import { parseExceptionsYaml } from '../exceptions/yaml';
import type { CfnTemplate, ExceptionEntry, StackMeta, StackTemplate } from '../types';

const SUFFIX = '.template.json';
const MANIFEST = 'manifest.json';

/** El id de stack de un template es el nombre del archivo sin `.template.json` (el artifact id de CDK). Igual en el plugin y en la CLI. */
export const stackIdOf = (templatePath: string): string => path.basename(templatePath).slice(0, -SUFFIX.length);

/**
 * Lee los metadatos de los stacks de un `manifest.json` (región y `terminationProtection`, que el template NO expone), indexados por el
 * nombre del archivo de template. Devuelve `undefined` si no hay manifest (un uso solo-templates); LANZA si existe y no se puede leer:
 * un manifest corrupto no equivale a «sin manifest».
 */
export function readManifestMeta(dir: string): Map<string, StackMeta> | undefined {
  const file = path.join(dir, MANIFEST);
  if (!fs.existsSync(file)) return undefined;
  let manifest: { artifacts?: Record<string, { type?: string; environment?: string; properties?: { templateFile?: string; terminationProtection?: boolean } }> };
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof manifest;
  } catch (e) {
    throw new Error(`No se pudo leer ${file}: ${(e as Error).message}`);
  }
  const out = new Map<string, StackMeta>();
  for (const a of Object.values(manifest.artifacts ?? {})) {
    if (a?.type !== 'aws:cloudformation:stack' || typeof a.properties?.templateFile !== 'string') continue;
    const region = /^aws:\/\/[^/]*\/([^/]+)$/.exec(a.environment ?? '')?.[1];
    out.set(path.basename(a.properties.templateFile), {
      region: region && !region.startsWith('unknown') ? region : undefined,
      terminationProtection: a.properties.terminationProtection === true,
    });
  }
  return out;
}

export function readTemplate(templatePath: string, meta?: StackMeta): StackTemplate {
  let template: CfnTemplate;
  try {
    template = JSON.parse(fs.readFileSync(templatePath, 'utf8')) as CfnTemplate;
  } catch (e) {
    throw new Error(`No se pudo leer el template ${templatePath}: ${(e as Error).message}`);
  }
  return { stack: stackIdOf(templatePath), template, ...(meta ? { meta } : {}) };
}

/**
 * Lee una lista de templates y les adjunta los metadatos de `manifest.json` (el de la carpeta de cada uno). Con manifest, un template
 * que no figura en él queda SIN `meta`, y la regla que lo necesite lo reporta: no se inventa un valor por omisión.
 */
export function readTemplates(templatePaths: string[]): StackTemplate[] {
  const manifests = new Map<string, Map<string, StackMeta> | undefined>();
  return templatePaths.map((p) => {
    const dir = path.dirname(p);
    if (!manifests.has(dir)) manifests.set(dir, readManifestMeta(dir));
    return readTemplate(p, manifests.get(dir)?.get(path.basename(p)));
  });
}

/**
 * Lee los `*.template.json` de un `cdk.out`. Falla (no devuelve [] en silencio) si el directorio no existe, no tiene templates o
 * contiene assemblies anidados (`assembly-*`, apps con Stage), que v1 no recorre: pasar en verde sin haberlos leído sería mentir.
 */
export function loadTemplatesFromDir(dir: string): StackTemplate[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`El directorio de salida de CDK no existe: ${dir}`);
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const nested = entries.filter((e) => e.isDirectory() && e.name.startsWith('assembly-')).map((e) => e.name);
  if (nested.length) {
    throw new Error(`${dir} contiene assemblies anidados (${nested.join(', ')}): las apps con Stage no están soportadas en v1; no se evaluaron sus templates.`);
  }
  const files = entries.filter((e) => e.isFile() && e.name.endsWith(SUFFIX)).map((e) => path.join(dir, e.name)).sort();
  if (!files.length) throw new Error(`${dir} no contiene ningún *${SUFFIX}: un cdk.out sin templates no prueba nada. ¿Corrió cdk synth?`);
  return readTemplates(files);
}

/** Lee governance/exceptions.yml. Si se pidió explícitamente y no existe, falla: un archivo ausente no puede equivaler a «sin excepciones». */
export function loadExceptionsFile(file: string): ExceptionEntry[] {
  if (!fs.existsSync(file)) throw new Error(`El archivo de excepciones no existe: ${file}`);
  return parseExceptionsYaml(fs.readFileSync(file, 'utf8'));
}
