# NX-BKP-002 — El plan de respaldo de la RDS copia a otra región

| | |
|---|---|
| **Severidad** | `warn` (aviso: no rompe el build ni el exit code) |
| **Aplica en** | `prod` |
| **Excepción** | Sí (declarada dos veces, con caducidad) |
| **Falla cerrado** | Sí (avisa cuando no puede comprobarlo) |

## Qué verifica

Para toda base de datos primaria (`AWS::RDS::DBInstance` y `AWS::RDS::DBCluster`; se omiten las instancias miembro de un cluster y las réplicas), algún `AWS::Backup::BackupPlan` que la selecciona tiene al menos una regla con una `CopyActions[]` cuyo `DestinationBackupVaultArn` apunta a un vault de **otra región**.

**Es autocontenida respecto de `NX-BKP-001`:** una base **sin** plan tampoco tiene copia cross-region y recibe el aviso (con el motivo «ningún plan la selecciona»), aunque `NX-BKP-001` ya la reporte como error. Así, arreglar el plan sin añadir la copia deja el aviso visible.

- La región se lee del ARN estático (`arn:<partición>:backup:<región>:…`) y se compara con la región del stack del plan (de `manifest.json`).
- Un destino que es un vault del propio app (por `Ref`/`GetAtt`/export) o un ARN con `Ref: AWS::Region` es la **misma** región.

**No resoluble:** un destino con región literal cuando la región del stack no se conoce (un uso solo-templates, sin `manifest.json`), un ARN ilegible, o una selección/plan que no se resuelve en el app **avisa** («no se puede comprobar…»): no se calla.

Mensaje cuando no hay copia: *se recomienda implementar copia cross-region*.

## Por qué

Un plan que solo respalda en la región de origen no sobrevive a la pérdida de la región ni a una cuenta de vault comprometida. La copia cross-region es la defensa de continuidad que más cuesta de añadir tarde. Es un aviso y no un error porque no todos los datos pueden salir de la región (residencia) y porque suma costo de transferencia y almacenamiento.

## Cómo corregirlo

```ts
const remote = backup.BackupVault.fromBackupVaultArn(this, 'Remote', 'arn:aws:backup:us-west-2:<ACCOUNT>:backup-vault:remote');
new backup.BackupPlan(this, 'Plan', {
  backupVault: vault,
  backupPlanRules: [new backup.BackupPlanRule({ copyActions: [{ destinationBackupVault: remote }] })],
});
```

Si los datos no pueden salir de la región, declare la excepción (dos veces, con motivo, dueño y caducidad).

## De dónde viene

Segunda mitad del estándar de respaldo de producción (`NX-BKP-001` es la primera). Nace como aviso (`warn`) para dar visibilidad en el resumen del workflow sin romper a los consumidores.

## Límites conocidos

- Solo mira `CopyActions`: no comprueba que el vault destino exista, esté bloqueado ni que la copia tenga retención.
- Un destino en otro stack del mismo app se considera la misma región (una referencia no cruza regiones).
