# NX-BKP-001 — En `prod` toda RDS tiene PITR y un BackupPlan con Vault Lock

| | |
|---|---|
| **Severidad** | `error` |
| **Aplica en** | `prod` |
| **Excepción** | Sí (declarada dos veces, con caducidad) |
| **Falla cerrado** | Sí (caso «no resoluble») |

## Qué verifica

Para toda base de datos primaria (`AWS::RDS::DBInstance` y `AWS::RDS::DBCluster`; se omiten las instancias miembro de un cluster y las réplicas):

1. **PITR:** `BackupRetentionPeriod` literal **>= 7**. Ausente equivale a 1 (default de CloudFormation) y es violación.
2. **Selección:** algún `AWS::Backup::BackupSelection` la **selecciona**. Se reconoce: una referencia a la base en `Resources` (`Ref`/`GetAtt`, también entre stacks por export o por parámetro SSM), un ARN con comodín total del identificador (`…:db:*`, `…:cluster:*`) o con el identificador literal de la base, y `ListOfTags`/`Conditions.StringEquals` que coinciden con un tag literal de la base. `NotResources` que la excluye anula la selección.
3. **Plan y vaults:** el `BackupPlanId` de la selección resuelve a un `AWS::Backup::BackupPlan` del app y **todas** sus reglas tienen `TargetBackupVault` que resuelve a un `AWS::Backup::BackupVault` del app **con `LockConfiguration`** (Vault Lock).
4. **Misma región:** si se conoce la región del stack de la base y la del vault (desde `manifest.json`) y difieren, es violación. Si no se conocen, la referencia directa o por export ya implica la misma región (CloudFormation no cruza regiones por referencia).

Pasa si **algún** plan que selecciona la base cumple 3 y 4.

### No resoluble (falla cerrado)

Se **reporta**, con «no se puede comprobar» y el motivo, cuando:

- `BackupRetentionPeriod` es un intrinsic;
- ninguna selección es decidible contra la base (referencias sin resolver, tags de la base como intrinsic, comodín parcial como `db:prod-*`);
- el plan de una selección no se resuelve en el app (p. ej. `BackupPlanId` de un parámetro o de otro repo);
- una regla del plan apunta a un vault que el app **no declara** (p. ej. `Default`, o un vault por nombre que otro repo crea): no se puede demostrar el lock;
- `LockConfiguration` es un intrinsic.

## Por qué

Los respaldos automáticos de RDS viven y mueren con la instancia, y un atacante o un error con permisos puede borrarlos. **Vault Lock** hace los puntos de recuperación inmutables durante su retención: es lo que convierte «tenemos backups» en «sobreviven a un borrado malicioso o accidental».

## Cómo corregirlo

```ts
const vault = new backup.BackupVault(this, 'Vault', {
  lockConfiguration: { minRetention: Duration.days(7), changeableFor: Duration.days(3) },
});
const plan = new backup.BackupPlan(this, 'Plan', { backupVault: vault });
plan.addSelection('Db', { resources: [backup.BackupResource.fromRdsDatabaseInstance(db)] });
new rds.DatabaseInstance(this, 'Db', { /* … */ backupRetention: Duration.days(14) });
```

## De dónde viene

Estándar de continuidad de producción: PITR para pérdida lógica, AWS Backup con Vault Lock para pérdida de la instancia o de credenciales. La forma de `Resources`, `BackupPlanId` y `TargetBackupVault` está verificada contra un synth real de `aws-cdk-lib`.

## Límites conocidos

- **Vault Lock en modo gobernanza cuenta** (sin `ChangeableForDays`): la regla exige que la inmutabilidad esté configurada, no el modo compliance.
- Los tags se comparan solo con `STRINGEQUALS` contra tags **literales** de la base; cualquier otra condición se trata como no resoluble. Con varias condiciones basta que una coincida.
- Un destino de copia (`CopyActions`) no se exige bloqueado.
- Una base protegida con otra herramienta de respaldo falla por diseño.
