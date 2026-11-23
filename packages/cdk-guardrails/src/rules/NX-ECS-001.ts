import { isLit, ofType, propsOf, where } from '../cfn';
import { literalBool } from '../links';
import { Finding, Rule } from '../types';

/**
 * NX-ECS-001: todo servicio ECS con controlador de despliegue ECS (el default) tiene el circuit breaker activo y con rollback. Sin él, un
 * despliegue que nunca llega a estable queda reintentando para siempre y el servicio roto es el que sigue en pie. Corre en TODOS los stages.
 */
export const rule: Rule = {
  id: 'NX-ECS-001',
  title: 'Todo servicio ECS lleva circuit breaker con rollback',
  severity: 'error',
  appliesTo: ['dev', 'stg', 'prod', 'shared'],
  allowsException: true,
  failsClosed: true,
  check(app) {
    const findings: Finding[] = [];
    for (const l of ofType(app, 'AWS::ECS::Service')) {
      const p = propsOf(l.res);
      const at = (msg: string): Finding => ({ stack: l.stack, resource: l.id, message: `[NX-ECS-001] ${where(l)}: ${msg} Ver docs/rules/NX-ECS-001.md` });
      const cannot = (what: string): Finding => at(`no se puede comprobar el circuit breaker: ${what} no es un literal. Declare el valor literal (el motor falla cerrado).`);

      // Controlador: solo el rodante de ECS usa el circuit breaker (CODE_DEPLOY y EXTERNAL lo gobiernan por fuera).
      if (p.DeploymentController !== undefined) {
        const type = isLit(p.DeploymentController) ? p.DeploymentController.Type : undefined;
        if (typeof type !== 'string') {
          findings.push(cannot('DeploymentController.Type'));
          continue;
        }
        if (type !== 'ECS') continue;
      }
      const dc = p.DeploymentConfiguration;
      if (dc !== undefined && !isLit(dc)) {
        findings.push(cannot('DeploymentConfiguration'));
        continue;
      }
      // Blue/green y canary nativos de ECS no usan el circuit breaker del despliegue rodante (supuesto conservador, spec Q2).
      const strategy = isLit(dc) ? dc.Strategy : undefined;
      if (typeof strategy === 'string' && strategy !== 'ROLLING') continue;
      if (strategy !== undefined && typeof strategy !== 'string') {
        findings.push(cannot('DeploymentConfiguration.Strategy'));
        continue;
      }

      const cb = isLit(dc) ? dc.DeploymentCircuitBreaker : undefined;
      if (cb === undefined) {
        findings.push(at('sin DeploymentConfiguration.DeploymentCircuitBreaker: un despliegue roto no se revierte solo. Active circuitBreaker con rollback (en CDK: `circuitBreaker: { rollback: true }`).'));
        continue;
      }
      if (!isLit(cb)) {
        findings.push(cannot('DeploymentCircuitBreaker'));
        continue;
      }
      const enable = literalBool(cb.Enable);
      const rollback = literalBool(cb.Rollback);
      if ((cb.Enable !== undefined && enable === undefined) || (cb.Rollback !== undefined && rollback === undefined)) {
        findings.push(cannot('DeploymentCircuitBreaker.Enable o .Rollback'));
      } else if (enable !== true || rollback !== true) {
        findings.push(at(`circuit breaker incompleto (Enable: ${String(enable ?? 'ausente')}, Rollback: ${String(rollback ?? 'ausente')}); ambos deben ser true.`));
      }
    }
    return findings;
  },
};
