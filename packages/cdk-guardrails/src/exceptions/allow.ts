import { EXCEPTION_METADATA_KEY, markIds } from './model';

/** Lo mínimo que `allowException` necesita de un `CfnResource` (estructural: este archivo no importa aws-cdk-lib). */
interface CfnLike {
  cfnOptions: { metadata?: Record<string, unknown> };
}
interface L2Like {
  node: { defaultChild?: unknown };
}
const isCfn = (x: unknown): x is CfnLike => typeof x === 'object' && x !== null && 'cfnOptions' in x;

/**
 * Mitad «código» de una excepción (spec §2.4): escribe `Metadata: { 'nextep:exception': [<regla>, …] }` en el recurso, de modo que la
 * marca VIAJA en el template y el motor la ve sin leer código fuente. Acepta un `CfnResource` o un L2 (usa su `defaultChild`).
 * No silencia nada por sí sola: hace falta la entrada en governance/exceptions.yml (guard = id de la regla, motivo, dueño y caducidad).
 */
export function allowException(resource: CfnLike | L2Like, ruleId: string): void {
  const target = isCfn(resource) ? resource : (resource as L2Like).node.defaultChild;
  if (!isCfn(target)) throw new Error(`allowException(${ruleId}): el recurso no es un CfnResource ni un L2 con defaultChild; pase el L1 explícitamente.`);
  const meta = (target.cfnOptions.metadata ??= {});
  meta[EXCEPTION_METADATA_KEY] = [...new Set([...markIds(meta[EXCEPTION_METADATA_KEY]), ruleId])];
}
