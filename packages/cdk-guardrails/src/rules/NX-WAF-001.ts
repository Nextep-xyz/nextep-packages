import { ofType, propsOf, where } from '../cfn';
import { pointsTo, resolveTargets } from '../links';
import { Finding, Rule, StackTemplate } from '../types';

/**
 * NX-WAF-001: en prod todo ALB expuesto a internet tiene una `AWS::WAFv2::WebACLAssociation` que lo referencia.
 * Sujeto: `Type` application (o ausente) con `Scheme` internet-facing (o ausente: es el default). Los NLB y los balanceadores de gateway no
 * admiten WAFv2 y no son sujeto. Falla cerrado: si el ALB no tiene asociación pero existe alguna cuyo `ResourceArn` no se puede resolver a un
 * recurso del app, no se puede descartar que sea la suya, y se reporta.
 */
export const rule: Rule = {
  id: 'NX-WAF-001',
  title: 'En prod todo ALB internet-facing tiene WAF asociado',
  severity: 'error',
  appliesTo: ['prod'],
  allowsException: true,
  failsClosed: true,
  check(app: StackTemplate[]) {
    const findings: Finding[] = [];
    const associations = ofType(app, 'AWS::WAFv2::WebACLAssociation');
    for (const lb of ofType(app, 'AWS::ElasticLoadBalancingV2::LoadBalancer')) {
      const p = propsOf(lb.res);
      const at = (msg: string): Finding => ({ stack: lb.stack, resource: lb.id, message: `[NX-WAF-001] ${where(lb)}: ${msg} Ver docs/rules/NX-WAF-001.md` });

      if ((p.Type !== undefined && typeof p.Type !== 'string') || (p.Scheme !== undefined && typeof p.Scheme !== 'string')) {
        findings.push(at('no se puede comprobar si es un ALB internet-facing (Type o Scheme no es un literal); se asume que lo es y se exige WAF.'));
        continue;
      }
      if (p.Type !== undefined && p.Type !== 'application') continue; // NLB y gateway: WAFv2 no se asocia
      if (p.Scheme !== undefined && p.Scheme !== 'internet-facing') continue; // internal

      if (associations.some((a) => pointsTo(app, a.stack, propsOf(a.res).ResourceArn, lb))) continue;

      // ¿Alguna asociación apunta a «algo que no se puede ver»? (ARN literal, parámetro, export ajeno): podría ser este ALB.
      const opaque = associations.filter((a) => {
        const r = resolveTargets(app, a.stack, propsOf(a.res).ResourceArn);
        return r.targets.length === 0 || r.unresolved;
      });
      if (opaque.length) {
        findings.push(
          at(
            `ninguna asociación WAF lo referencia y no se puede comprobar si la de ${opaque.map((a) => `${a.stack}/${a.id}`).join(', ')} es la suya (ResourceArn no resuelve a un recurso del app). ` +
              'Referencie el balanceador con Ref/GetAtt en el ResourceArn.',
          ),
        );
      } else {
        findings.push(at('ALB internet-facing sin AWS::WAFv2::WebACLAssociation. Asocie una WebACL regional (CDK: `new wafv2.CfnWebACLAssociation(…, { resourceArn: alb.loadBalancerArn, webAclArn })`).'));
      }
    }
    return findings;
  },
};
