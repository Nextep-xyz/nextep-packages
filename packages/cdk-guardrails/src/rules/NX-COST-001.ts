import { ofType, where } from '../cfn';
import { Rule } from '../types';

/** NX-COST-001: no existe ningún AWS::CloudWatch::Dashboard (cada dashboard cobra por mes y nadie sabe que lo creó). */
export const rule: Rule = {
  id: 'NX-COST-001',
  title: 'Sin dashboards de CloudWatch',
  severity: 'error',
  appliesTo: ['dev', 'stg', 'prod', 'shared'],
  allowsException: true,
  check: (app) =>
    ofType(app, 'AWS::CloudWatch::Dashboard').map((l) => ({
      stack: l.stack,
      resource: l.id,
      message: `[NX-COST-001] ${where(l)}: los dashboards de CloudWatch cobran por dashboard y por mes y es fácil crearlos sin saberlo; muestra la métrica en la herramienta de observabilidad del equipo. Ver docs/rules/NX-COST-001.md`,
    })),
};
