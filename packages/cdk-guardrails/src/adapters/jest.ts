import { evaluate } from '../engine';
import { formatViolations } from '../format';
import type { ExceptionEntry, Stage } from '../types';
import { loadExceptionsFile, loadTemplatesFromDir } from './load';

export interface CompliantOptions {
  stage: Stage;
  sharedStacks?: string[];
  /** Ruta a governance/exceptions.yml del proyecto. */
  exceptionsFile?: string;
  exceptions?: ExceptionEntry[];
  now?: Date;
}

/** Lo mínimo que se necesita de un `App` de CDK: `synth()` devuelve un assembly con su directorio. */
interface AppLike {
  synth(): { directory: string };
}

/**
 * Helper de Jest (adaptador 2): sintetiza el app, evalúa el catálogo sobre los templates reales y falla con la lista completa de
 * violaciones (cada una nombra regla, stack y recurso). Independiente del plugin: sirve aunque el proyecto no lo haya instalado.
 */
export function expectNextepCompliant(app: AppLike, opts: CompliantOptions): void {
  const directory = app.synth().directory;
  const templates = loadTemplatesFromDir(directory);
  const exceptions = opts.exceptions ?? (opts.exceptionsFile ? loadExceptionsFile(opts.exceptionsFile) : []);
  const violations = evaluate(templates, { stage: opts.stage, sharedStacks: opts.sharedStacks, exceptions, now: opts.now });
  if (violations.some((v) => v.severity === 'error')) {
    throw new Error(`El app no cumple los guardarrailes de Nextep:\n${formatViolations(violations, opts.stage)}`);
  }
}
