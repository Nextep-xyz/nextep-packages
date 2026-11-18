import * as fs from 'fs';
import * as path from 'path';
import { parseExceptionsYaml } from '../exceptions/yaml';
import type { CfnTemplate, ExceptionEntry, StackTemplate } from '../types';

const SUFFIX = '.template.json';

/** El id de stack de un template es el nombre del archivo sin `.template.json` (el artifact id de CDK). Igual en el plugin y en la CLI. */
export const stackIdOf = (templatePath: string): string => path.basename(templatePath).slice(0, -SUFFIX.length);

export function readTemplate(templatePath: string): StackTemplate {
  let template: CfnTemplate;
  try {
    template = JSON.parse(fs.readFileSync(templatePath, 'utf8')) as CfnTemplate;
  } catch (e) {
    throw new Error(`No se pudo leer el template ${templatePath}: ${(e as Error).message}`);
  }
  return { stack: stackIdOf(templatePath), template };
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
  return files.map(readTemplate);
}

/** Lee governance/exceptions.yml. Si se pidió explícitamente y no existe, falla: un archivo ausente no puede equivaler a «sin excepciones». */
export function loadExceptionsFile(file: string): ExceptionEntry[] {
  if (!fs.existsSync(file)) throw new Error(`El archivo de excepciones no existe: ${file}`);
  return parseExceptionsYaml(fs.readFileSync(file, 'utf8'));
}
