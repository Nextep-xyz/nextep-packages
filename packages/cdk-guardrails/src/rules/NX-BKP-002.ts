import { isObj, primaryDatabases, propsOf, where } from '../cfn';
import { copyDestination, nameOf, protectionOf } from '../backup';
import { Finding, Rule, StackTemplate } from '../types';

/**
 * NX-BKP-002 (aviso): la RDS tiene una copia de respaldo hacia OTRA región, vía un `CopyAction` del plan de AWS Backup que la protege. Sin ella,
 * la pérdida de la región (o de la cuenta del vault) se lleva también los respaldos. Es `warn`: no rompe el build.
 *
 * Es autocontenida respecto de NX-BKP-001: una base SIN plan tampoco tiene copia cross-region y recibe el aviso (con el motivo), aunque
 * NX-BKP-001 ya la reporte como error: cada regla dice su parte, y arreglar el plan sin añadir la copia deja visible el aviso.
 */
export const rule: Rule = {
  id: 'NX-BKP-002',
  title: 'La RDS tiene copia de respaldo a otra región',
  severity: 'warn',
  appliesTo: ['prod'],
  allowsException: true,
  failsClosed: true,
  check(app: StackTemplate[]) {
    const findings: Finding[] = [];
    const advice = 'Se recomienda implementar copia cross-region (CopyAction a un vault de otra región). Ver docs/rules/NX-BKP-002.md';
    for (const db of primaryDatabases(app)) {
      const at = (msg: string): Finding => ({ stack: db.stack, resource: db.id, message: `[NX-BKP-002] ${where(db)}: ${msg}. ${advice}` });
      const prot = protectionOf(app, db);
      const planned = prot.selecting.filter((v) => v.plan !== undefined);

      if (planned.length === 0) {
        if (prot.selecting.length > 0 || prot.ambiguous.length > 0) {
          findings.push(at('no se puede comprobar qué plan la protege (selección o plan no resolubles en el app), así que no se puede comprobar que tenga copia cross-region'));
        } else {
          findings.push(at('ningún plan de AWS Backup la selecciona, así que tampoco tiene copia cross-region (NX-BKP-001 lo reporta como error)'));
        }
        continue;
      }

      let cross = false;
      let unknown = false;
      const plans: string[] = [];
      for (const v of planned) {
        const plan = v.plan!;
        plans.push(nameOf(plan));
        const bp = propsOf(plan.res).BackupPlan;
        const rules = isObj(bp) && Array.isArray(bp.BackupPlanRule) ? (bp.BackupPlanRule as unknown[]) : [];
        for (const r of rules) {
          const copies = isObj(r) && Array.isArray(r.CopyActions) ? (r.CopyActions as unknown[]) : [];
          for (const c of copies) {
            const d = isObj(c) ? copyDestination(app, plan, c.DestinationBackupVaultArn) : 'unknown';
            if (d === 'cross-region') cross = true;
            else if (d === 'unknown') unknown = true;
          }
        }
      }
      if (cross) continue;
      const names = [...new Set(plans)].join(', ');
      findings.push(
        at(
          unknown
            ? `el plan ${names} tiene una CopyAction cuyo destino no se puede comparar con la región del stack (ARN no resoluble o región del stack desconocida: sin manifest.json); no se puede comprobar que sea cross-region`
            : `el plan ${names} no tiene ninguna CopyAction hacia un vault de otra región`,
        ),
      );
    }
    return findings;
  },
};
