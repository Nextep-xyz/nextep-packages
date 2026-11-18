import * as path from 'path';
import fg from 'fast-glob';

export interface DiscoverOptions {
  /** Directorio base de la busqueda. Obligatorio: un default implicito (process.cwd()) hace que el gate cambie segun desde donde se corra. */
  cwd: string;
  /** Minimo de sujetos. Obligatorio y >= 1: un gate sin sujetos pasa en verde y no prueba nada. */
  min: number;
  ignore?: string[];
  /** Incluir dotfiles (p. ej. .github/). Por defecto no. */
  dot?: boolean;
}

const DEFAULT_IGNORE = ['**/node_modules/**', '**/cdk.out/**', '**/dist/**'];

/**
 * Descubre sujetos por disco. NUNCA se alimenta de una lista de imports: el caso que importa es el archivo nuevo, escrito por quien no
 * leyo la regla. Lanza si hay menos de `min` sujetos. Devuelve rutas relativas a `cwd`, con `/`, ordenadas.
 */
export function discover(globs: string[], opts: DiscoverOptions): string[] {
  if (!Number.isInteger(opts.min) || opts.min < 1) {
    throw new Error(`discover(): "min" debe ser un entero >= 1 (recibido: ${opts.min}); un gate sin sujetos no prueba nada`);
  }
  const found = fg
    .sync(globs, { cwd: opts.cwd, onlyFiles: true, dot: opts.dot ?? false, ignore: [...DEFAULT_IGNORE, ...(opts.ignore ?? [])] })
    .map((f) => f.replace(/\\/g, '/'))
    .sort();
  if (found.length < opts.min) {
    throw new Error(
      `Descubrimiento con ${found.length === 0 ? '0 sujetos' : `${found.length} sujetos (menos de ${opts.min})`} ` +
        `para los globs [${globs.join(', ')}] en ${opts.cwd}. Un gate que no encuentra sujetos no prueba nada.`,
    );
  }
  return found;
}

/** Como `discover`, pero devuelve los directorios unicos que contienen los sujetos. */
export function discoverDirs(globs: string[], opts: DiscoverOptions): string[] {
  return [...new Set(discover(globs, opts).map((f) => path.posix.dirname(f)))].sort();
}
