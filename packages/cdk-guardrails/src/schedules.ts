// Lectura compartida de AWS::Scheduler::Schedule para las reglas NX-POWER-*.
import { Located, ofType, propsOf, universalTarget, UniversalTarget } from './cfn';
import type { StackTemplate } from './types';

export interface ScheduleInfo {
  loc: Located;
  /** undefined si el target no es un target universal de Scheduler (p. ej. una Lambda por GetAtt). */
  target: UniversalTarget | undefined;
  /** El schedule está explícitamente DISABLED. Un valor no literal se trata como habilitado. */
  disabled: boolean;
  expression: unknown;
}

export function schedules(app: StackTemplate[]): ScheduleInfo[] {
  return ofType(app, 'AWS::Scheduler::Schedule').map((loc) => {
    const p = propsOf(loc.res);
    const target = p.Target && typeof p.Target === 'object' ? (p.Target as Record<string, unknown>) : {};
    return { loc, target: universalTarget(target.Arn), disabled: p.State === 'DISABLED', expression: p.ScheduleExpression };
  });
}

/** `rds:stopdbinstance`: servicio y acción en minúsculas (CloudFormation y los SDK las escriben en camelCase). */
export const actionKey = (t: UniversalTarget): string => `${t.service}:${t.action}`.toLowerCase();
