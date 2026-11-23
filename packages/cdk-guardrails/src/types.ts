// Tipos públicos del motor. Sin dependencia de aws-cdk-lib: el motor opera sobre el JSON sintetizado.
// NOTA de imports: dentro de src/ los imports son RELATIVOS a propósito. Este paquete se publica compilado con `tsc` y los alias de
// tsconfig (@guardrails/*, solo de este monorepo) no sobreviven a la compilación. Los tests y los gates, que no se publican, usan el alias.

export const STAGES = ['dev', 'stg', 'prod', 'shared'] as const;
export type Stage = (typeof STAGES)[number];
export type Severity = 'error' | 'warn';

/** Una entrada de governance/exceptions.yml del proyecto (campos id, guard, reason, owner, expires). */
export interface ExceptionEntry {
  id: string;
  /** Id de la regla a la que aplica (p. ej. NX-COST-002). */
  guard: string;
  reason: string;
  owner: string;
  /** YYYY-MM-DD, vigente hasta el final de ese día (UTC). */
  expires: string;
}

export interface GuardrailsContext {
  /** Explícito; nunca se adivina por el nombre del stack. */
  stage: Stage;
  /** Ids de los stacks SIN ambiente (p. ej. un stack de dominio compartido). Lista explícita, sin patrones (spec Q16). */
  sharedStacks?: string[];
  exceptions: ExceptionEntry[];
  /** Inyectable para probar caducidades. */
  now?: Date;
}

export interface CfnResource {
  Type: string;
  Properties?: Record<string, unknown>;
  Metadata?: Record<string, unknown>;
}
export interface CfnTemplate {
  Resources?: Record<string, CfnResource>;
  Parameters?: Record<string, { Type?: string; Default?: unknown }>;
  Outputs?: Record<string, { Value?: unknown; Export?: { Name?: unknown } }>;
}
/**
 * Lo que el template de CloudFormation NO expone pero `manifest.json` del cdk.out sí (región y protección contra terminación del stack).
 * `meta` ausente en un StackTemplate = no había manifest: una regla que lo necesite no puede evaluar esa parte.
 */
export interface StackMeta {
  /** Región de `artifacts[<stack>].environment` (`aws://<cuenta>/<región>`); undefined si el stack no tiene región concreta. */
  region?: string;
  terminationProtection?: boolean;
}

/** Un template sintetizado (`cdk.out/<stack>.template.json`) con el id del stack al que pertenece. */
export interface StackTemplate {
  stack: string;
  template: CfnTemplate;
  meta?: StackMeta;
}

export interface Violation {
  ruleId: string;
  severity: Severity;
  stack: string;
  resource?: string;
  /** Siempre nombra la regla, el stack y el recurso: la CLI de CDK solo muestra el archivo del template. */
  message: string;
}

/** Lo que devuelve una regla; el motor le agrega ruleId y severity. */
export interface Finding {
  stack: string;
  resource?: string;
  message: string;
  /**
   * ¿Este hallazgo admite excepción? Por defecto, lo que diga la regla. Solo puede RESTRINGIR: un hallazgo nunca es más permisivo que
   * su regla (`allowsException: false` manda). Existe porque una misma regla puede tener hallazgos que se aceptan con motivo
   * (p. ej. exceder un techo) y otros que no (p. ej. un log group eterno).
   */
  exceptable?: boolean;
}

export interface Rule {
  /** NX-<ÁREA>-<NNN>. Congelado (spec Q3, I2). */
  id: string;
  title: string;
  severity: Severity;
  /** Stages en los que la regla corre; en los demás no genera ruido. */
  appliesTo: readonly Stage[];
  /** ¿Admite una excepción declarada dos veces? (spec §2.4) */
  allowsException: boolean;
  /**
   * La regla tiene camino de «falla cerrado» (no puede demostrar el cumplimiento y reporta). El gate GR1 exige entonces el fixture
   * `fixtures/<id>/fail-unresolvable/`. Opcional: las reglas v1 no lo declaran.
   */
  failsClosed?: boolean;
  check(app: StackTemplate[], ctx: GuardrailsContext): Finding[];
}
