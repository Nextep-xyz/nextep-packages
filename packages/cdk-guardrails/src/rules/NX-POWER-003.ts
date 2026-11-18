import { ofType, propsOf, staticText, where } from '../cfn';
import { actionKey, schedules } from '../schedules';
import { Finding, Rule } from '../types';

/**
 * NX-POWER-003: en dev y stg, si el app tiene una RDS (no Aurora Serverless v2), existe un schedule de stop Y uno de start.
 * Versión gruesa a propósito: mira el app completo, no relaciona el schedule con la instancia por identificador
 * (si el identificador llega por SSM, el template no lo vincula). Nace en `error` porque se verificó que el cruce entre stacks es fiable.
 */
export const rule: Rule = {
  id: 'NX-POWER-003',
  title: 'En dev y stg la RDS tiene apagado y arranque programados',
  severity: 'error',
  appliesTo: ['dev', 'stg'],
  allowsException: true,
  check(app) {
    const enabled = new Set(schedules(app).filter((s) => !s.disabled && s.target?.complete).map((s) => actionKey(s.target!)));
    const findings: Finding[] = [];
    for (const l of ofType(app, 'AWS::RDS::DBInstance')) {
      const p = propsOf(l.res);
      const cls = staticText(p.DBInstanceClass);
      if (cls?.complete && cls.text.toLowerCase() === 'db.serverless') continue; // Aurora Serverless v2: escala a mínimo, no se detiene
      const inCluster = p.DBClusterIdentifier !== undefined; // Aurora aprovisionado: se detiene el clúster, no la instancia
      const need = inCluster ? ['rds:stopdbcluster', 'rds:startdbcluster'] : ['rds:stopdbinstance', 'rds:startdbinstance'];
      const missing = need.filter((k) => !enabled.has(k));
      if (!missing.length) continue;
      const names = missing.map((k) => (k.includes('stop') ? 'stop' : 'start') + (inCluster ? 'DBCluster' : 'DBInstance'));
      findings.push({
        stack: l.stack,
        resource: l.id,
        message: `[NX-POWER-003] ${where(l)}: en dev/stg falta un AWS::Scheduler::Schedule habilitado con target ${names.join(' y ')} en el app. Ver docs/rules/NX-POWER-003.md`,
      });
    }
    return findings;
  },
};
