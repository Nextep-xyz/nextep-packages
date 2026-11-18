import { scheduleCadence, staticText, where } from '../cfn';
import { actionKey, schedules } from '../schedules';
import { Finding, Rule } from '../types';

/**
 * NX-POWER-004: un schedule con target stopDBInstance NO corre todos los días: su cron restringe el día de la semana.
 * `StopDBInstance` falla contra una instancia ya detenida y enciende la alarma cada sábado.
 * NO admite excepción: el error es de AWS, no de política.
 */
export const rule: Rule = {
  id: 'NX-POWER-004',
  title: 'El stop de RDS no corre todos los días',
  severity: 'error',
  appliesTo: ['dev', 'stg'],
  allowsException: false,
  check(app) {
    const findings: Finding[] = [];
    for (const s of schedules(app)) {
      if (!s.target?.complete || actionKey(s.target) !== 'rds:stopdbinstance') continue;
      const expr = staticText(s.expression);
      const base = `[NX-POWER-004] ${where(s.loc)}`;
      if (!expr || !expr.complete) {
        findings.push({ stack: s.loc.stack, resource: s.loc.id, message: `${base}: ScheduleExpression no es un literal; no se puede comprobar que restrinja el día de la semana. Ver docs/rules/NX-POWER-004.md` });
        continue;
      }
      const cadence = scheduleCadence(expr.text);
      if (cadence === 'unrestricted' || cadence === 'unknown') {
        const why = cadence === 'unknown' ? 'no se pudo interpretar' : 'corre todos los días';
        findings.push({
          stack: s.loc.stack,
          resource: s.loc.id,
          message: `${base}: "${expr.text}" ${why}; StopDBInstance falla contra una instancia ya detenida. Restrinja el día de la semana (p. ej. MON-FRI). Ver docs/rules/NX-POWER-004.md`,
        });
      }
    }
    return findings;
  },
};
