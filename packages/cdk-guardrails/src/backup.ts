// Qué BackupPlan protege a una base de datos RDS, leído del template (selecciones, planes y vaults de AWS Backup). Lo comparten NX-BKP-001 y
// NX-BKP-002. Sin red, sin fs, sin aws-cdk-lib. Todo lo que no se puede resolver queda como «unknown»: la regla falla cerrado.
import { HOLE, isLit, isObj, Located, ofType, propsOf, staticText, tagMap } from './cfn';
import { resolveTargets } from './links';
import type { StackTemplate } from './types';

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

export type Match = 'yes' | 'no' | 'unknown';

/** ¿Esta selección de AWS Backup incluye a la base de datos `db`? `unknown` si no se puede decidir con lo que dice el template. */
export function selects(app: StackTemplate[], sel: Located, db: Located): Match {
  const bs = propsOf(sel.res).BackupSelection;
  if (!isLit(bs)) return 'unknown';
  let unknown = false;

  // NotResources manda: si la excluye, no está seleccionada.
  for (const r of asList(bs.NotResources)) {
    const rt = resolveTargets(app, sel.stack, r);
    if (rt.targets.some((t) => t.stack === db.stack && t.id === db.id)) return 'no';
    if (rt.unresolved) unknown = true;
  }

  const dbProps = propsOf(db.res);
  const ident = typeof dbProps.DBInstanceIdentifier === 'string' ? dbProps.DBInstanceIdentifier : typeof dbProps.DBClusterIdentifier === 'string' ? dbProps.DBClusterIdentifier : undefined;
  for (const r of asList(bs.Resources)) {
    const rt = resolveTargets(app, sel.stack, r);
    if (rt.targets.some((t) => t.stack === db.stack && t.id === db.id)) return 'yes';
    if (rt.unresolved) {
      unknown = true;
      continue;
    }
    if (rt.targets.length > 0) continue; // apunta a OTRO recurso del app
    // Un ARN literal. Solo un comodín total del identificador (`…:db:*`, `…:cluster:*`, `*`) o el identificador literal de ESTA base la selecciona.
    const text = typeof r === 'string' ? r : (staticText(r)?.text ?? HOLE);
    const m = /^arn:[^:]*:rds:[^:]*:[^:]*:(db|cluster):(.*)$/.exec(text);
    if (text === '*') return 'yes';
    if (!m) continue;
    const id = m[2] as string;
    if (id === '*') return 'yes';
    if (ident !== undefined && id === ident) return 'yes';
    if (id.includes('*') || id.includes(HOLE)) unknown = true; // comodín parcial o identificador con un hueco: no se puede decidir
  }

  // Selección por tags: coincide si alguna condición STRINGEQUALS coincide con un tag literal de la base.
  const conds: { key: string; value: unknown }[] = [];
  let opaqueConds = false;
  for (const c of asList(bs.ListOfTags)) {
    if (isObj(c) && typeof c.ConditionKey === 'string' && (c.ConditionType === undefined || c.ConditionType === 'STRINGEQUALS')) conds.push({ key: c.ConditionKey, value: c.ConditionValue });
    else opaqueConds = true;
  }
  const modern = isObj(bs.Conditions) ? bs.Conditions : undefined;
  for (const c of asList(modern?.StringEquals)) {
    if (isObj(c) && typeof c.ConditionKey === 'string') conds.push({ key: c.ConditionKey.replace(/^aws:ResourceTag\//, ''), value: c.ConditionValue });
    else opaqueConds = true;
  }
  for (const other of ['StringLike', 'StringNotEquals', 'StringNotLike']) if (modern && modern[other] !== undefined) opaqueConds = true;
  if (conds.length) {
    const tags = tagMap(dbProps);
    if (!tags) unknown = true;
    else if (conds.some((c) => typeof c.value === 'string' && tags[c.key] === c.value)) return 'yes';
  }
  if (opaqueConds) unknown = true;
  return unknown ? 'unknown' : 'no';
}

export interface VaultVerdict {
  /** Nombre legible de la regla del plan. */
  rule: string;
  vault?: Located;
  /** Lo que impide aceptar este vault: sin resolver, sin lock o en otra región. */
  problems: string[];
  /** Lo que no se pudo comprobar (falla cerrado). */
  unknown: string[];
}

export interface PlanVerdict {
  selection: Located;
  plan?: Located;
  rules: VaultVerdict[];
  /** Problemas que no son de una regla concreta (plan que no resuelve, plan sin reglas). */
  planProblems: string[];
  /** true si el plan existe, tiene reglas y TODAS apuntan a un vault del app con Vault Lock y en la misma región. */
  ok: boolean;
}

export interface Protection {
  /** Planes que seleccionan la base (resueltos o no). */
  selecting: PlanVerdict[];
  /** Selecciones que podrían seleccionarla pero no se pueden decidir. */
  ambiguous: Located[];
}

const metaRegion = (app: StackTemplate[], stack: string): string | undefined => app.find((s) => s.stack === stack)?.meta?.region;

function vaultOf(app: StackTemplate[], plan: Located, value: unknown): Located | undefined {
  const t = resolveTargets(app, plan.stack, value).targets.find((x) => x.res.Type === 'AWS::Backup::BackupVault');
  if (t) return t;
  // Por nombre literal: `TargetBackupVault: "name"` y un vault del app con ese BackupVaultName.
  if (typeof value === 'string') return ofType(app, 'AWS::Backup::BackupVault').find((v) => propsOf(v.res).BackupVaultName === value);
  return undefined;
}

/** Evalúa cada plan que selecciona `db`: ¿sus reglas van a vaults del app con Vault Lock y en la misma región que la base? */
export function protectionOf(app: StackTemplate[], db: Located): Protection {
  const selecting: PlanVerdict[] = [];
  const ambiguous: Located[] = [];
  for (const sel of ofType(app, 'AWS::Backup::BackupSelection')) {
    const m = selects(app, sel, db);
    if (m === 'unknown') ambiguous.push(sel);
    if (m !== 'yes') continue;
    const plan = resolveTargets(app, sel.stack, propsOf(sel.res).BackupPlanId).targets.find((t) => t.res.Type === 'AWS::Backup::BackupPlan');
    const verdict: PlanVerdict = { selection: sel, plan, rules: [], planProblems: [], ok: false };
    selecting.push(verdict);
    if (!plan) {
      verdict.planProblems.push(`la selección ${sel.stack}/${sel.id} apunta a un plan que no se puede resolver en el app (BackupPlanId no resuelve a un AWS::Backup::BackupPlan)`);
      continue;
    }
    const bp = propsOf(plan.res).BackupPlan;
    const rules = isLit(bp) ? asList(bp.BackupPlanRule) : [];
    if (!isLit(bp) || !Array.isArray(bp.BackupPlanRule)) verdict.planProblems.push(`el plan ${plan.stack}/${plan.id} no tiene BackupPlanRule literal`);
    else if (rules.length === 0) verdict.planProblems.push(`el plan ${plan.stack}/${plan.id} no tiene reglas`);
    rules.forEach((r, i) => {
      const name = isObj(r) && typeof r.RuleName === 'string' ? r.RuleName : `#${i}`;
      const rv: VaultVerdict = { rule: name, problems: [], unknown: [] };
      verdict.rules.push(rv);
      const vault = isObj(r) ? vaultOf(app, plan, r.TargetBackupVault) : undefined;
      if (!vault) {
        rv.unknown.push(`la regla ${name} del plan ${plan.id} apunta a un vault que el app no declara (TargetBackupVault no resuelve a un AWS::Backup::BackupVault): no se puede demostrar el Vault Lock`);
        return;
      }
      rv.vault = vault;
      const lock = propsOf(vault.res).LockConfiguration;
      if (lock === undefined) rv.problems.push(`el vault ${vault.stack}/${vault.id} no tiene LockConfiguration (Vault Lock)`);
      else if (!isLit(lock)) rv.unknown.push(`no se puede comprobar LockConfiguration del vault ${vault.stack}/${vault.id} (no es un literal)`);
      const dbRegion = metaRegion(app, db.stack);
      const vRegion = metaRegion(app, vault.stack);
      if (dbRegion && vRegion && dbRegion !== vRegion) rv.problems.push(`el vault ${vault.stack}/${vault.id} está en ${vRegion} y la base en ${dbRegion}: AWS Backup exige la misma región`);
    });
    verdict.ok = verdict.planProblems.length === 0 && verdict.rules.length > 0 && verdict.rules.every((r) => r.problems.length === 0 && r.unknown.length === 0);
  }
  return { selecting, ambiguous };
}

export type Destination = 'cross-region' | 'same-region' | 'unknown';

/** Región de destino de una `CopyAction`: se compara el ARN literal con la región del stack del plan. */
export function copyDestination(app: StackTemplate[], plan: Located, arn: unknown): Destination {
  // Un vault del app (por Ref/GetAtt/export) es de la misma región: CloudFormation no cruza regiones por referencia.
  const rt = resolveTargets(app, plan.stack, arn);
  if (rt.targets.some((t) => t.res.Type === 'AWS::Backup::BackupVault')) return 'same-region';
  const st = staticText(arn);
  if (!st) return 'unknown';
  const m = /^arn:[^:]*:backup:([^:]*):/.exec(st.text);
  if (!m) return 'unknown';
  const region = m[1] as string;
  if (region.includes(HOLE)) return JSON.stringify(arn).includes('"Ref":"AWS::Region"') ? 'same-region' : 'unknown';
  const mine = metaRegion(app, plan.stack);
  if (!mine) return 'unknown';
  return region === mine ? 'same-region' : 'cross-region';
}

/** Para los mensajes: el nombre de un plan o selección. */
export const nameOf = (l: Located | undefined): string => (l ? `${l.stack}/${l.id}` : '(sin resolver)');
