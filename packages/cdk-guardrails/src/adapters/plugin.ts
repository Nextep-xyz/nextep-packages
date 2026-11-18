import { evaluate } from '../engine';
import { ALL_RULES } from '../rules';
import type { ExceptionEntry, Stage, Violation } from '../types';
import { loadExceptionsFile, readTemplate, stackIdOf } from './load';

/** Nombre del plugin: es el espacio de nombres de las marcas de `Validations.acknowledge` (`NextepGuardrails::<regla>`). */
export const PLUGIN_NAME = 'NextepGuardrails';
const ACK_METADATA_TYPE = 'aws:cdk:acknowledged-rules';

export interface GuardrailsPluginOptions {
  stage: Stage;
  sharedStacks?: string[];
  /** Ruta a governance/exceptions.yml del proyecto. Si se pasa y no existe, falla. */
  exceptionsFile?: string;
  /** Alternativa a `exceptionsFile` (útil en tests). */
  exceptions?: ExceptionEntry[];
  now?: Date;
}

// Tipos estructurales: compatibles con IPolicyValidationPlugin (estable, `Validations.of(app).addPlugins`) y con IPolicyValidationPluginBeta1
// (`new App({ policyValidationBeta1 })`, deprecada) sin importar aws-cdk-lib en tiempo de compilación (spikes S1-A).
interface ConstructLike {
  node: { findAll(): ConstructLike[]; metadata: { type: string; data: unknown }[] };
}
export interface PolicyValidationContextLike {
  templatePaths: string[];
  appConstruct?: ConstructLike;
}
export interface PolicyReportLike {
  success: boolean;
  violations: {
    ruleName: string;
    description: string;
    fix?: string;
    severity?: string;
    violatingResources: { resourceLogicalId: string; templatePath: string; locations: string[] }[];
  }[];
}

/**
 * Cierra el bypass de `Validations.of(app).acknowledge({ id: 'NextepGuardrails::<regla>' })` (spikes S1-B): CDK silenciaría la violación
 * sin pasar por governance/exceptions.yml. El plugin VE las marcas; si encuentra una en su espacio de nombres, LANZA (un throw aborta el
 * synth sin pasar por el reporte, así que no se puede silenciar con otro acknowledge).
 */
function rejectAcknowledgments(app: ConstructLike | undefined): void {
  if (!app) return;
  const acked: string[] = [];
  for (const c of app.node.findAll()) {
    for (const m of c.node.metadata) {
      if (m.type !== ACK_METADATA_TYPE || typeof m.data !== 'object' || m.data === null) continue;
      acked.push(...Object.keys(m.data).filter((k) => k.startsWith(`${PLUGIN_NAME}::`)));
    }
  }
  if (acked.length) {
    throw new Error(
      `${PLUGIN_NAME}: Validations.acknowledge no puede silenciar reglas de este plugin (${[...new Set(acked)].join(', ')}). ` +
        'La única forma de excepción es allowException(recurso, regla) + una entrada en governance/exceptions.yml con motivo, dueño y caducidad.',
    );
  }
}

export class NextepGuardrailsPlugin {
  readonly name = PLUGIN_NAME;
  readonly version = '0.1.0';
  readonly ruleIds = ALL_RULES.map((r) => r.id);
  private readonly exceptions: ExceptionEntry[];

  constructor(private readonly opts: GuardrailsPluginOptions) {
    // Se resuelve aquí (no en validate) para que un archivo de excepciones ausente o mal formado falle al construir el App.
    this.exceptions = opts.exceptions ?? (opts.exceptionsFile ? loadExceptionsFile(opts.exceptionsFile) : []);
  }

  validate(context: PolicyValidationContextLike): PolicyReportLike {
    rejectAcknowledgments(context.appConstruct);
    const templates = context.templatePaths.map(readTemplate);
    const violations = evaluate(templates, { stage: this.opts.stage, sharedStacks: this.opts.sharedStacks, exceptions: this.exceptions, now: this.opts.now });
    const pathOf = (v: Violation): string => context.templatePaths.find((p) => stackIdOf(p) === v.stack) ?? (context.templatePaths[0] as string);
    return {
      success: !violations.some((v) => v.severity === 'error'),
      violations: violations.map((v) => ({
        ruleName: v.ruleId,
        // La CLI de CDK solo imprime el archivo del template y el logical id: el mensaje completo (con stack y recurso) va en la descripción.
        description: v.message,
        fix: `docs/rules/${v.ruleId}.md`,
        severity: v.severity,
        violatingResources: [{ resourceLogicalId: v.resource ?? v.stack, templatePath: pathOf(v), locations: [] }],
      })),
    };
  }
}

/** Instala el plugin en el App con la API estable (`Validations.of(app).addPlugins`). Para aws-cdk-lib sin `Validations`, pase el plugin en `policyValidationBeta1`. */
export function installGuardrails(app: unknown, opts: GuardrailsPluginOptions): NextepGuardrailsPlugin {
  const plugin = new NextepGuardrailsPlugin(opts);
  // aws-cdk-lib es peerDependency: se carga aquí, no al importar el paquete (la CLI y el helper de Jest no la necesitan).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cdk = require('aws-cdk-lib') as { Validations?: { of(scope: unknown): { addPlugins(...p: unknown[]): void } } };
  if (!cdk.Validations) {
    throw new Error('installGuardrails: esta versión de aws-cdk-lib no tiene Validations (se requiere >=2.275.0). Alternativa: new App({ policyValidationBeta1: [new NextepGuardrailsPlugin(opts)] }).');
  }
  cdk.Validations.of(app).addPlugins(plugin);
  return plugin;
}
