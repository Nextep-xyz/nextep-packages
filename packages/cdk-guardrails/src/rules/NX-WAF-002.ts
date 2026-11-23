import { isLit, ofType, propsOf, where } from '../cfn';
import { pointsTo, resolveTargets } from '../links';
import { Finding, Rule, StackTemplate } from '../types';

/**
 * NX-WAF-002 (aviso): una WebACL en prod no debe quedarse solo observando ni a ciegas.
 *  1. Si tiene managed rule groups y TODOS están en count (`OverrideAction.Count`), la ACL no bloquea nada.
 *  2. Si no tiene `AWS::WAFv2::LoggingConfiguration`, no hay registro de lo que bloquea ni de lo que deja pasar.
 * Falla cerrado (avisa) cuando no puede comprobar un override o la configuración de logging.
 */
export const rule: Rule = {
  id: 'NX-WAF-002',
  title: 'La WebACL no está solo en count y tiene logging',
  severity: 'warn',
  appliesTo: ['prod'],
  allowsException: true,
  failsClosed: true,
  check(app: StackTemplate[]) {
    const findings: Finding[] = [];
    const logging = ofType(app, 'AWS::WAFv2::LoggingConfiguration');
    for (const acl of ofType(app, 'AWS::WAFv2::WebACL')) {
      const p = propsOf(acl.res);
      const at = (msg: string): Finding => ({ stack: acl.stack, resource: acl.id, message: `[NX-WAF-002] ${where(acl)}: ${msg} Ver docs/rules/NX-WAF-002.md` });

      // 1. Managed rule groups (primer nivel) y su modo.
      if (p.Rules !== undefined && !Array.isArray(p.Rules)) {
        findings.push(at('no se puede comprobar Rules (no es una lista literal); no se sabe si los managed rule groups bloquean.'));
      } else {
        const rules = (p.Rules ?? []) as unknown[];
        const opaqueRules = rules.filter((r) => !isLit(r) || (r.Statement !== undefined && !isLit(r.Statement))).length;
        const managed = rules.filter((r) => isLit(r) && isLit(r.Statement) && r.Statement.ManagedRuleGroupStatement !== undefined) as Record<string, unknown>[];
        const modes = managed.map((r) => (isLit(r.OverrideAction) ? ('Count' in r.OverrideAction ? 'count' : 'enforce') : 'unknown'));
        if (modes.includes('unknown') || opaqueRules > 0) {
          if (!modes.includes('enforce')) findings.push(at('no se puede comprobar el modo (OverrideAction) de algún managed rule group (es un intrinsic o la regla no es literal); no se sabe si bloquea.'));
        } else if (managed.length > 0 && modes.every((m) => m === 'count')) {
          findings.push(at(`todos sus managed rule groups (${managed.length}) están en count: la ACL solo observa y no bloquea nada. Pase al menos los grupos base a modo bloqueo (OverrideAction None) cuando termine el ajuste.`));
        }
      }

      // 2. Logging.
      if (logging.some((l) => pointsTo(app, l.stack, propsOf(l.res).ResourceArn, acl))) continue;
      const opaque = logging.filter((l) => {
        const r = resolveTargets(app, l.stack, propsOf(l.res).ResourceArn);
        return r.targets.length === 0 || r.unresolved;
      });
      if (opaque.length) {
        findings.push(at(`no se puede comprobar si la LoggingConfiguration ${opaque.map((l) => `${l.stack}/${l.id}`).join(', ')} es la de esta ACL (ResourceArn no resuelve a un recurso del app).`));
      } else {
        findings.push(at('sin AWS::WAFv2::LoggingConfiguration: no queda registro de lo que la ACL bloquea ni de lo que deja pasar. Configure el logging (CloudWatch Logs, S3 o Firehose).'));
      }
    }
    return findings;
  },
};
