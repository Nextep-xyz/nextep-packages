import { isObj, isPrimaryDb, ofType, propsOf, where } from '../cfn';
import { literalBool } from '../links';
import { Finding, Rule, StackTemplate } from '../types';

/**
 * NX-PROT-001: en prod nada de lo que tiene estado o da la cara se borra de un click.
 *  1. RDS/Aurora con `DeletionProtection: true`.
 *  2. ALB con el atributo `deletion_protection.enabled` en `true`.
 *  3. Cada stack con `TerminationProtection`. El TEMPLATE no lo expone; `manifest.json` del cdk.out sí, y el motor lo recibe como `meta`.
 *     Sin ningún manifest (uso solo-templates) esta parte no se evalúa; con manifest, un stack que no figura en él falla cerrado.
 */
export const rule: Rule = {
  id: 'NX-PROT-001',
  title: 'En prod, protección contra borrado en RDS, ALB y stacks',
  severity: 'error',
  appliesTo: ['prod'],
  allowsException: true,
  failsClosed: true,
  check(app: StackTemplate[]) {
    const findings: Finding[] = [];

    for (const type of ['AWS::RDS::DBInstance', 'AWS::RDS::DBCluster']) {
      for (const l of ofType(app, type)) {
        const p = propsOf(l.res);
        if (!isPrimaryDb(type, p)) continue;
        const dp = literalBool(p.DeletionProtection);
        const at = (msg: string): Finding => ({ stack: l.stack, resource: l.id, message: `[NX-PROT-001] ${where(l)}: ${msg} Ver docs/rules/NX-PROT-001.md` });
        if (p.DeletionProtection !== undefined && dp === undefined) findings.push(at('no se puede comprobar DeletionProtection (no es un literal); debe ser true en prod.'));
        else if (dp !== true) findings.push(at(`DeletionProtection ${p.DeletionProtection === undefined ? 'ausente (el default es false)' : 'es false'}; en prod debe ser true (CDK: \`deletionProtection: true\`).`));
      }
    }

    for (const l of ofType(app, 'AWS::ElasticLoadBalancingV2::LoadBalancer')) {
      const p = propsOf(l.res);
      const at = (msg: string): Finding => ({ stack: l.stack, resource: l.id, message: `[NX-PROT-001] ${where(l)}: ${msg} Ver docs/rules/NX-PROT-001.md` });
      if (p.Type !== undefined && typeof p.Type !== 'string') {
        findings.push(at('no se puede comprobar el tipo de balanceador (Type no es un literal), así que no se sabe si exige deletion_protection.enabled.'));
        continue;
      }
      if (p.Type !== undefined && p.Type !== 'application') continue; // NLB y gateway: fuera de alcance de esta versión (spec Q5)
      const attrs = p.LoadBalancerAttributes;
      if (attrs !== undefined && !Array.isArray(attrs)) {
        findings.push(at('no se puede comprobar LoadBalancerAttributes (no es una lista literal).'));
        continue;
      }
      const list = (attrs ?? []) as unknown[];
      const hit = list.find((a) => isObj(a) && a.Key === 'deletion_protection.enabled');
      if (!hit && list.some((a) => !isObj(a) || typeof a.Key !== 'string')) {
        findings.push(at('no se puede comprobar deletion_protection.enabled (algún atributo tiene una clave que no es un literal).'));
        continue;
      }
      const v = isObj(hit) ? literalBool(hit.Value) : undefined;
      if (isObj(hit) && hit.Value !== undefined && v === undefined) findings.push(at('no se puede comprobar deletion_protection.enabled (el valor no es un literal); debe ser "true" en prod.'));
      else if (v !== true) findings.push(at('sin el atributo deletion_protection.enabled = "true" (CDK: `deletionProtection: true`); un ALB de prod se borra sin confirmación.'));
    }

    // TerminationProtection: solo si el app trae metadatos del manifest.
    if (app.some((s) => s.meta !== undefined)) {
      for (const s of app) {
        const at = (msg: string): Finding => ({
          stack: s.stack,
          resource: '(stack)',
          exceptable: false, // no hay un recurso donde marcar la excepción
          message: `[NX-PROT-001] ${s.stack}/(stack) (stack de CloudFormation): ${msg} Ver docs/rules/NX-PROT-001.md`,
        });
        if (s.meta === undefined) findings.push(at('no se puede comprobar TerminationProtection: el stack no figura en manifest.json del cdk.out.'));
        else if (s.meta.terminationProtection !== true) findings.push(at('TerminationProtection desactivada; en prod todo stack la lleva (CDK: `terminationProtection: true`).'));
      }
    }
    return findings;
  },
};
