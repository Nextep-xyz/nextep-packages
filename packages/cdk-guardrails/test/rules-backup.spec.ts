import type { CfnResource, StackTemplate, Stage } from '@guardrails/src/types';
import { entry, evalAll, marked, msgs, oneStack, R, run, stack } from '@guardrails/test/helpers';

// Bordes de NX-BKP-001 y NX-BKP-002 (spec guardrails-prod-readiness §3.1 y §3.2) que los fixtures no cubren.

const att = (id: string, a: string): unknown => ({ 'Fn::GetAtt': [id, a] });
const db = (p: Record<string, unknown> = {}): CfnResource => R('AWS::RDS::DBInstance', { DBInstanceClass: 'db.t4g.medium', Engine: 'postgres', BackupRetentionPeriod: 14, ...p });
const vault = (locked: boolean, name = 'v'): CfnResource => R('AWS::Backup::BackupVault', { BackupVaultName: name, ...(locked ? { LockConfiguration: { MinRetentionDays: 7 } } : {}) });
const plan = (...rules: Record<string, unknown>[]): CfnResource => R('AWS::Backup::BackupPlan', { BackupPlan: { BackupPlanName: 'p', BackupPlanRule: rules } });
const rule = (vaultId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ RuleName: `to-${vaultId}`, TargetBackupVault: att(vaultId, 'BackupVaultName'), ...extra });
const arnOf = (id: string): unknown => ({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':rds:us-east-2:', { Ref: 'AWS::AccountId' }, ':db:', { Ref: id }]] });
const sel = (planId: string, resources: unknown[], extra: Record<string, unknown> = {}): CfnResource =>
  R('AWS::Backup::BackupSelection', { BackupPlanId: att(planId, 'BackupPlanId'), BackupSelection: { SelectionName: 's', IamRoleArn: 'r', Resources: resources, ...extra } });
const remote = (region: string): unknown => ({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:backup:${region}:`, { Ref: 'AWS::AccountId' }, ':backup-vault:remote']] });
const base = (extra: Record<string, CfnResource> = {}): StackTemplate[] =>
  oneStack('Data', { V: vault(true), P: plan(rule('V')), D: db(), S: sel('P', [arnOf('D')]), ...extra });

describe('NX-BKP-001: bordes', () => {
  it('un conjunto conforme (PITR 14, selección por ARN, plan con vault bloqueado) pasa', () => {
    expect(run(base(), 'prod', 'NX-BKP-001')).toEqual([]);
  });

  it('solo corre en prod', () => {
    const app = oneStack('Data', { D: db({ BackupRetentionPeriod: 1 }) });
    expect(run(app, 'prod', 'NX-BKP-001')).toEqual(['Data/D']);
    for (const st of ['dev', 'stg', 'shared'] as Stage[]) expect(run(app, st, 'NX-BKP-001')).toEqual([]);
  });

  it('PITR: 6 falla, 7 pasa; el valor como texto se lee igual; ausente cuenta como 1', () => {
    expect(run(base({ D: db({ BackupRetentionPeriod: 6 }) }), 'prod', 'NX-BKP-001')).toEqual(['Data/D']);
    expect(run(base({ D: db({ BackupRetentionPeriod: '7' }) }), 'prod', 'NX-BKP-001')).toEqual([]);
    expect(msgs(base({ D: db({ BackupRetentionPeriod: undefined }) }), 'prod', 'NX-BKP-001')).toMatch(/ausente \(el default es 1/);
  });

  it('una selección con comodín total del identificador (…:db:*) selecciona a todas', () => {
    const wildcard = { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':rds:us-east-2:', { Ref: 'AWS::AccountId' }, ':db:*']] };
    expect(run(base({ S: sel('P', [wildcard]) }), 'prod', 'NX-BKP-001')).toEqual([]);
  });

  it('un comodín PARCIAL (db:prod-*) no se puede decidir: falla cerrado, no pasa', () => {
    const partial = { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':rds:us-east-2:', { Ref: 'AWS::AccountId' }, ':db:prod-*']] };
    const app = base({ S: sel('P', [partial]) });
    expect(run(app, 'prod', 'NX-BKP-001')).toEqual(['Data/D']);
    expect(msgs(app, 'prod', 'NX-BKP-001')).toMatch(/no se puede comprobar: qué plan la protege/);
  });

  it('un ARN literal con el identificador de ESTA base la selecciona; el de otra no', () => {
    const lit = (id: string): unknown => ({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':rds:us-east-2:', { Ref: 'AWS::AccountId' }, `:db:${id}`]] });
    expect(run(base({ D: db({ DBInstanceIdentifier: 'mine' }), S: sel('P', [lit('mine')]) }), 'prod', 'NX-BKP-001')).toEqual([]);
    expect(run(base({ D: db({ DBInstanceIdentifier: 'mine' }), S: sel('P', [lit('other')]) }), 'prod', 'NX-BKP-001')).toEqual(['Data/D']);
  });

  it('NotResources: si la excluye, no está seleccionada', () => {
    const app = base({ S: sel('P', [{ 'Fn::Join': ['', ['arn:aws:rds:us-east-2:', { Ref: 'AWS::AccountId' }, ':db:*']] }], { NotResources: [arnOf('D')] }) });
    expect(run(app, 'prod', 'NX-BKP-001')).toEqual(['Data/D']);
  });

  it('selección por tags: coincide con el tag literal de la base; con otro valor, no', () => {
    const bySel = (value: string): CfnResource => R('AWS::Backup::BackupSelection', { BackupPlanId: att('P', 'BackupPlanId'), BackupSelection: { SelectionName: 't', IamRoleArn: 'r', ListOfTags: [{ ConditionType: 'STRINGEQUALS', ConditionKey: 'backup', ConditionValue: value }] } });
    const tagged = db({ Tags: [{ Key: 'backup', Value: 'daily' }] });
    expect(run(base({ D: tagged, S: bySel('daily') }), 'prod', 'NX-BKP-001')).toEqual([]);
    expect(run(base({ D: tagged, S: bySel('weekly') }), 'prod', 'NX-BKP-001')).toEqual(['Data/D']);
  });

  it('selección por tags con Tags de la base como intrinsic: falla cerrado', () => {
    const bySel = R('AWS::Backup::BackupSelection', { BackupPlanId: att('P', 'BackupPlanId'), BackupSelection: { SelectionName: 't', IamRoleArn: 'r', ListOfTags: [{ ConditionType: 'STRINGEQUALS', ConditionKey: 'backup', ConditionValue: 'daily' }] } });
    expect(msgs(base({ D: db({ Tags: { 'Fn::If': ['c', [], []] } }), S: bySel }), 'prod', 'NX-BKP-001')).toMatch(/no se puede comprobar: qué plan la protege/);
  });

  it('un plan con DOS reglas, una a un vault sin lock: falla nombrando el vault', () => {
    const app = base({ Open: vault(false, 'open'), P: plan(rule('V'), rule('Open')) });
    expect(run(app, 'prod', 'NX-BKP-001')).toEqual(['Data/D']);
    expect(msgs(app, 'prod', 'NX-BKP-001')).toMatch(/el vault Data\/Open no tiene LockConfiguration/);
  });

  it('con DOS planes que seleccionan la base, basta que UNO cumpla', () => {
    const app = base({ Open: vault(false, 'open'), P2: plan(rule('Open')), S2: sel('P2', [arnOf('D')]) });
    expect(run(app, 'prod', 'NX-BKP-001')).toEqual([]);
  });

  it('el vault por nombre literal que el app declara se resuelve; uno que no declara (Default) falla cerrado', () => {
    const byName = plan({ RuleName: 'r', TargetBackupVault: 'v' });
    expect(run(base({ P: byName }), 'prod', 'NX-BKP-001')).toEqual([]);
    const dflt = plan({ RuleName: 'r', TargetBackupVault: 'Default' });
    expect(msgs(base({ P: dflt }), 'prod', 'NX-BKP-001')).toMatch(/apunta a un vault que el app no declara/);
  });

  it('LockConfiguration como intrinsic: falla cerrado', () => {
    const v = R('AWS::Backup::BackupVault', { BackupVaultName: 'v', LockConfiguration: { 'Fn::If': ['c', { MinRetentionDays: 7 }, { Ref: 'AWS::NoValue' }] } });
    expect(msgs(base({ V: v }), 'prod', 'NX-BKP-001')).toMatch(/no se puede comprobar LockConfiguration/);
  });

  it('misma región: con regiones conocidas y distintas, falla; iguales o desconocidas, pasa', () => {
    const vaults = stack('Vaults', { V: vault(true), P: plan(rule('V')) }, { Outputs: { Pid: { Value: att('P', 'BackupPlanId'), Export: { Name: 'Vaults:Plan' } } } });
    const data = (region?: string): StackTemplate[] => [
      vaults,
      stack('Data', { D: db(), S: R('AWS::Backup::BackupSelection', { BackupPlanId: { 'Fn::ImportValue': 'Vaults:Plan' }, BackupSelection: { SelectionName: 's', IamRoleArn: 'r', Resources: [arnOf('D')] } }) }, {}, region ? { region } : undefined),
    ];
    // el export no resuelve el plan por Ref (apunta al GetAtt del plan): sí resuelve al recurso P
    expect(run(data(), 'prod', 'NX-BKP-001')).toEqual([]);
    const withMeta = (a: string, b: string): StackTemplate[] => [{ ...vaults, meta: { region: a } }, { ...(data(b)[1] as StackTemplate) }];
    expect(run(withMeta('us-east-2', 'us-east-2'), 'prod', 'NX-BKP-001')).toEqual([]);
    expect(run(withMeta('eu-west-1', 'us-east-2'), 'prod', 'NX-BKP-001')).toEqual(['Data/D']);
    expect(msgs(withMeta('eu-west-1', 'us-east-2'), 'prod', 'NX-BKP-001')).toMatch(/está en eu-west-1 y la base en us-east-2/);
  });

  it('el plan en otro stack, enlazado por parámetro SSM (el patrón de los stacks de referencia), se resuelve', () => {
    const backup = stack('Backup', { V: vault(true), P: plan(rule('V')), Param: R('AWS::SSM::Parameter', { Name: '/shop/prod/backup/plan-id', Type: 'String', Value: att('P', 'BackupPlanId') }) });
    const data = stack(
      'Data',
      { D: db(), S: R('AWS::Backup::BackupSelection', { BackupPlanId: { Ref: 'PlanParam' }, BackupSelection: { SelectionName: 's', IamRoleArn: 'r', Resources: [arnOf('D')] } }) },
      { Parameters: { PlanParam: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/shop/prod/backup/plan-id' } } },
    );
    expect(run([backup, data], 'prod', 'NX-BKP-001')).toEqual([]);
  });

  it('Aurora: el cluster se juzga; la instancia miembro y la réplica no', () => {
    const app = oneStack('Data', {
      V: vault(true), P: plan(rule('V')),
      C: R('AWS::RDS::DBCluster', { Engine: 'aurora-postgresql', BackupRetentionPeriod: 1 }),
      M: db({ DBClusterIdentifier: { Ref: 'C' }, BackupRetentionPeriod: undefined }),
      Rep: db({ SourceDBInstanceIdentifier: 'x', BackupRetentionPeriod: undefined }),
    });
    expect(run(app, 'prod', 'NX-BKP-001')).toEqual(['Data/C']);
  });

  it('admite excepción declarada dos veces', () => {
    const app = oneStack('Data', { D: marked(db({ BackupRetentionPeriod: 1 }), 'NX-BKP-001') });
    expect(run(app, 'prod', 'NX-BKP-001', { exceptions: [entry('NX-BKP-001')] })).toEqual([]);
  });
});

describe('NX-BKP-002: bordes (aviso)', () => {
  const withCopy = (region: string, regionOfStack = 'us-east-2'): StackTemplate[] => [
    stack('Data', { V: vault(true), P: plan(rule('V', { CopyActions: [{ DestinationBackupVaultArn: remote(region) }] })), D: db(), S: sel('P', [arnOf('D')]) }, {}, { region: regionOfStack }),
  ];

  it('es un AVISO (severidad warn) y corre solo en prod', () => {
    const found = evalAll(withCopy('us-east-2'), 'prod').filter((v) => v.ruleId === 'NX-BKP-002');
    expect(found.map((v) => [v.severity, v.stack, v.resource])).toEqual([['warn', 'Data', 'D']]);
    for (const st of ['dev', 'stg', 'shared'] as Stage[]) expect(run(withCopy('us-east-2'), st, 'NX-BKP-002')).toEqual([]);
  });

  it('copia a otra región: pasa; a la misma: aviso', () => {
    expect(run(withCopy('us-west-2'), 'prod', 'NX-BKP-002')).toEqual([]);
    expect(run(withCopy('us-east-2'), 'prod', 'NX-BKP-002')).toEqual(['Data/D']);
  });

  it('el mensaje recomienda implementar copia cross-region', () => {
    expect(msgs(withCopy('us-east-2'), 'prod', 'NX-BKP-002')).toMatch(/Se recomienda implementar copia cross-region/);
  });

  it('un destino con Ref a AWS::Region es la misma región', () => {
    const sameRegion = { 'Fn::Join': ['', ['arn:aws:backup:', { Ref: 'AWS::Region' }, ':', { Ref: 'AWS::AccountId' }, ':backup-vault:x']] };
    const app = [stack('Data', { V: vault(true), P: plan(rule('V', { CopyActions: [{ DestinationBackupVaultArn: sameRegion }] })), D: db(), S: sel('P', [arnOf('D')]) }, {}, { region: 'us-east-2' })];
    expect(run(app, 'prod', 'NX-BKP-002')).toEqual(['Data/D']);
  });

  it('un destino que es un vault del app (GetAtt Arn) es la misma región', () => {
    const app = [stack('Data', { V: vault(true), V2: vault(true, 'v2'), P: plan(rule('V', { CopyActions: [{ DestinationBackupVaultArn: att('V2', 'BackupVaultArn') }] })), D: db(), S: sel('P', [arnOf('D')]) }, {}, { region: 'us-east-2' })];
    expect(run(app, 'prod', 'NX-BKP-002')).toEqual(['Data/D']);
  });

  it('sin manifest (región del stack desconocida) con destino literal: avisa que no pudo comprobarlo, no calla', () => {
    const app = oneStack('Data', { V: vault(true), P: plan(rule('V', { CopyActions: [{ DestinationBackupVaultArn: remote('us-west-2') }] })), D: db(), S: sel('P', [arnOf('D')]) });
    expect(msgs(app, 'prod', 'NX-BKP-002')).toMatch(/no se puede comprobar que sea cross-region/);
  });

  it('una base SIN plan también recibe el aviso (autocontenida: sin plan no hay copia cross-region), con el motivo y remitiendo a NX-BKP-001', () => {
    expect(run(oneStack('Data', { D: db() }), 'prod', 'NX-BKP-002')).toEqual(['Data/D']);
    expect(msgs(oneStack('Data', { D: db() }), 'prod', 'NX-BKP-002')).toMatch(/ningún plan de AWS Backup la selecciona.*NX-BKP-001 lo reporta como error/);
  });

  it('un plan que no se puede resolver avisa que no pudo comprobarlo', () => {
    const app = oneStack('Data', { D: db(), S: R('AWS::Backup::BackupSelection', { BackupPlanId: { Ref: 'ExternalPlan' }, BackupSelection: { SelectionName: 's', IamRoleArn: 'r', Resources: [arnOf('D')] } }) });
    expect(msgs(app, 'prod', 'NX-BKP-002')).toMatch(/no se puede comprobar qué plan la protege/);
  });

  it('una copia entre varias reglas basta', () => {
    const app = [stack('Data', { V: vault(true), P: plan(rule('V'), rule('V', { RuleName: 'weekly', CopyActions: [{ DestinationBackupVaultArn: remote('us-west-2') }] })), D: db(), S: sel('P', [arnOf('D')]) }, {}, { region: 'us-east-2' })];
    expect(run(app, 'prod', 'NX-BKP-002')).toEqual([]);
  });

  it('admite excepción declarada dos veces (p. ej. residencia de datos)', () => {
    const app = [stack('Data', { V: vault(true), P: plan(rule('V')), D: marked(db(), 'NX-BKP-002'), S: sel('P', [arnOf('D')]) }, {}, { region: 'us-east-2' })];
    expect(run(app, 'prod', 'NX-BKP-002', { exceptions: [entry('NX-BKP-002')] })).toEqual([]);
  });
});

