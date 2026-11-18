import { ofType, propsOf, where } from '../cfn';
import { Finding, Rule } from '../types';

/** NX-COST-003: Container Insights solo en prod. En dev y stg, `containerInsights` debe ser `disabled` (o no estar declarado). */
export const rule: Rule = {
  id: 'NX-COST-003',
  title: 'Container Insights solo en prod',
  severity: 'error',
  appliesTo: ['dev', 'stg'],
  allowsException: true,
  check(app, ctx) {
    const findings: Finding[] = [];
    for (const l of ofType(app, 'AWS::ECS::Cluster')) {
      const settings = propsOf(l.res).ClusterSettings;
      if (!Array.isArray(settings)) continue;
      for (const s of settings as Record<string, unknown>[]) {
        if (s?.Name !== 'containerInsights') continue;
        if (s.Value === 'disabled') continue;
        const shown = typeof s.Value === 'string' ? `"${s.Value}"` : 'un intrinsic no resoluble';
        findings.push({
          stack: l.stack,
          resource: l.id,
          message: `[NX-COST-003] ${where(l)}: containerInsights es ${shown} en ${ctx.stage}; solo se admite en prod (cada métrica cobra). Ver docs/rules/NX-COST-003.md`,
        });
      }
    }
    return findings;
  },
};
