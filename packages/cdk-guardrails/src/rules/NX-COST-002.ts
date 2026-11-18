import { ofType, propsOf, staticText, where } from '../cfn';
import { Finding, Rule } from '../types';

/** NX-COST-002: ninguna instancia RDS `.micro` ni `.nano` (el 2026-10-05 no eran ordenables en us-east-1 y una instancia de dev no arrancó). */
export const rule: Rule = {
  id: 'NX-COST-002',
  title: 'RDS nunca micro ni nano',
  severity: 'error',
  appliesTo: ['dev', 'stg', 'prod', 'shared'],
  allowsException: true,
  check(app) {
    const findings: Finding[] = [];
    for (const l of ofType(app, 'AWS::RDS::DBInstance')) {
      const cls = staticText(propsOf(l.res).DBInstanceClass);
      if (!cls || !cls.complete) {
        findings.push({
          stack: l.stack,
          resource: l.id,
          message: `[NX-COST-002] ${where(l)}: DBInstanceClass no es un literal (depende de un intrinsic) y no se puede comprobar que no sea micro/nano. Ver docs/rules/NX-COST-002.md`,
        });
      } else if (/\.(micro|nano)$/i.test(cls.text)) {
        findings.push({
          stack: l.stack,
          resource: l.id,
          message: `[NX-COST-002] ${where(l)}: DBInstanceClass "${cls.text}" es micro/nano; use db.t4g.small o mayor. Ver docs/rules/NX-COST-002.md`,
        });
      }
    }
    return findings;
  },
};
