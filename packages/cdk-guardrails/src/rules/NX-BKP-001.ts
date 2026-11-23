import { numberOf, primaryDatabases, propsOf, where } from '../cfn';
import { nameOf, protectionOf } from '../backup';
import { Finding, Rule, StackTemplate } from '../types';

/** Retención mínima (días) de los respaldos automáticos de RDS (PITR) que exige la regla. */
export const MIN_BACKUP_RETENTION_DAYS = 7;

/**
 * NX-BKP-001: en prod toda RDS/Aurora tiene PITR (BackupRetentionPeriod >= 7) y está seleccionada por un BackupPlan de AWS Backup cuyos
 * vaults tienen Vault Lock, en la misma región. Falla cerrado: una selección, un plan o un vault que el template no permite resolver es una
 * violación con mensaje explícito, no un pase.
 */
export const rule: Rule = {
  id: 'NX-BKP-001',
  title: 'En prod toda RDS tiene PITR y un BackupPlan con Vault Lock',
  severity: 'error',
  appliesTo: ['prod'],
  allowsException: true,
  failsClosed: true,
  check(app: StackTemplate[]) {
    const findings: Finding[] = [];
    for (const db of primaryDatabases(app)) {
      const p = propsOf(db.res);
      const problems: string[] = [];
      const unknown: string[] = [];

      // 1. PITR. Ausente = 1 día (default de CloudFormation).
      if (p.BackupRetentionPeriod === undefined) problems.push(`BackupRetentionPeriod ausente (el default es 1; PITR exige >= ${MIN_BACKUP_RETENTION_DAYS})`);
      else {
        const n = numberOf(p.BackupRetentionPeriod);
        if (n === undefined) unknown.push('BackupRetentionPeriod (no es un literal)');
        else if (n < MIN_BACKUP_RETENTION_DAYS) problems.push(`BackupRetentionPeriod es ${n} (PITR exige >= ${MIN_BACKUP_RETENTION_DAYS})`);
      }

      // 2 y 3. Selección → plan → vaults con lock en la misma región.
      const prot = protectionOf(app, db);
      if (prot.selecting.length === 0) {
        if (prot.ambiguous.length) unknown.push(`qué plan la protege: la selección ${prot.ambiguous.map(nameOf).join(', ')} no se puede evaluar contra esta base (referencias o tags no resolubles)`);
        else problems.push('ningún AWS::Backup::BackupSelection la selecciona (no hay copia de respaldo con Vault Lock)');
      } else if (!prot.selecting.some((v) => v.ok)) {
        // Ningún plan cumple: se explica por qué falla cada uno.
        for (const v of prot.selecting) {
          problems.push(...v.planProblems.filter(() => v.plan !== undefined));
          unknown.push(...v.planProblems.filter(() => v.plan === undefined));
          for (const r of v.rules) {
            problems.push(...r.problems);
            unknown.push(...r.unknown);
          }
        }
      }

      if (problems.length || unknown.length) {
        const parts = [...problems, ...(unknown.length ? [`no se puede comprobar: ${[...new Set(unknown)].join('; ')}`] : [])];
        findings.push({ stack: db.stack, resource: db.id, message: `[NX-BKP-001] ${where(db)}: ${[...new Set(parts)].join('; ')}. Ver docs/rules/NX-BKP-001.md` });
      }
    }
    return findings;
  },
};
