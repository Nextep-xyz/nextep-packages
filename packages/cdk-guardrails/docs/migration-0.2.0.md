# Migración a 0.2.0: reglas de preparación para producción

`0.2.0` añade **diez reglas**. Siete son `error` y **pueden romper el build de un proyecto que hoy pasa en verde**: es un cambio incompatible (por eso sube el minor en 0.x y el pin es por versión exacta: nadie lo recibe sin cambiar la URL del tarball). Tres son `warn` y **no rompen nada**: salen como avisos amarillos.

## Cómo medir el impacto antes de subir (sin tocar nada)

En una rama, con la versión nueva instalada, corra la CLI sobre el `cdk.out` real de **cada** stage (dev, stg, prod) y lea qué dispara. No hace falta desplegar nada:

```powershell
foreach ($s in 'dev','stg','prod') {
  pnpm exec cdk synth --quiet -c stage=$s -o "cdk.out/guardrails/$s"
  pnpm exec nextep-guardrails check --out "cdk.out/guardrails/$s" --stage $s --format text
}
```

Cada línea nombra **regla, stack y recurso**. El detalle de cada regla (qué mira, falsos positivos, cómo arreglarla) está en `docs/rules/<id>.md`.

## Qué rompe y cómo arreglarlo

| Regla | Stages | Qué falla típicamente en un proyecto existente | Cómo se arregla |
|---|---|---|---|
| `NX-LOG-001` | todos | **El más probable.** Las Lambdas que CDK crea por ti (helper de `Custom::LogRetention`, framework de `cr.Provider`, `AwsCustomResource`, `CustomResourceProvider` internos) dejan su log group **implícito y eterno**; también los exports de logs de RDS sin retención, CodeBuild sin `LogsConfig`, ECS con `awslogs-create-group`, y log groups con más de 365 días | Un `logs.LogGroup` con `retention` asignado por `logGroup` en el construct (el mensaje identifica cuál es y cómo). Más de 365 días: bajar, o excepción con caducidad. **El log group eterno no admite excepción** |
| `NX-ECS-001` | todos | Servicios ECS creados sin `circuitBreaker` | `circuitBreaker: { rollback: true }` |
| `NX-PROT-001` | prod | RDS/Aurora sin `deletionProtection`, ALB sin `deletion_protection.enabled`, **stacks sin `terminationProtection`** (se lee de `manifest.json`: afecta a **todos** los stacks del synth de prod, también los sin ambiente) | `deletionProtection: true`; `terminationProtection: true` en el `Stack`. Ojo: activarlos en un recurso existente no reemplaza nada, pero **desactivarlos después exige un cambio revisado** |
| `NX-S3-001` | prod | Buckets sin versioning, sin `blockPublicAccess: BLOCK_ALL` o sin `enforceSSL`. Los buckets que **el propio app usa como destino de logs de acceso** (ALB, CloudFront) quedan exentos **solo del versioning** | `versioned: true`, `blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL`, `enforceSSL: true`. Sitio estático público a propósito: excepción |
| `NX-BKP-001` | prod | RDS sin `BackupRetentionPeriod` >= 7 o **sin plan de AWS Backup con Vault Lock** (la mayoría de proyectos solo tiene los respaldos automáticos de RDS) | `backupRetention: Duration.days(7+)`; un `BackupVault` con `lockConfiguration`, un `BackupPlan` y un `addSelection` con la base. Un vault por nombre (`Default`) que el app no declara falla cerrado |
| `NX-WAF-001` | prod | ALB internet-facing sin `WebACLAssociation` (o con una asociación cuyo `ResourceArn` es un ARN literal) | `CfnWebACLAssociation` con `resourceArn: alb.loadBalancerArn`. Detrás de CloudFront con WAF allí: excepción |
| `NX-POWER-005` | prod | Servicios con `DesiredCount: 0` heredado de dev, o `MinCapacity: 0` en el escalado (este último ya fallaba `NX-POWER-001`) | `desiredCount` >= 1 (o quitarlo si hay autoescalado); `minCapacity: 1`. Un servicio de prod que se apaga a propósito **no** es una excepción de esta regla: `NX-POWER-001` lo prohíbe sin excepción |

### Avisos (no rompen el build)

| Regla | Qué avisa | Cómo se arregla |
|---|---|---|
| `NX-BKP-002` | La RDS no tiene copia de respaldo a otra región (también avisa cuando no hay plan: `NX-BKP-001` lo reporta como error) | `CopyAction` a un vault de otra región; si los datos no pueden salir de la región, excepción |
| `NX-WAF-002` | La WebACL tiene todos los managed rule groups en count, o no tiene `LoggingConfiguration` | Pasar los grupos base a `OverrideAction: None` y configurar el logging |
| `NX-ALM-001` | Un topic usado como destino de alarmas no tiene suscriptor en el app | Un `AWS::SNS::Subscription` (o Chatbot) |

## Cambios de comportamiento que no son reglas

- **`--format github`** (autodetectado con `GITHUB_ACTIONS=true`): la salida de la CLI en Actions pasa a ser anotaciones `::error`/`::warning`. El **exit code no cambia** (`1` solo con errores). Si algún script de su pipeline parsea el texto `ERROR`/`WARN` de la salida de la CLI dentro de Actions, use `--format text`.
- **`GITHUB_STEP_SUMMARY`:** la CLI anexa una tabla al resumen del run si la variable existe.
- **Plugin:** los avisos llegan a CDK con severidad `warning` (antes ninguna regla era `warn`). Con `success: true` el synth **no** aborta. Si su proyecto activa el modo estricto de CDK (`@aws-cdk/core:strictCfnValidateErrors`), un `warning` hace fallar el synth: es el comportamiento de CDK.
- **Helper de Jest:** las `warn` no lanzan, pero ahora se imprimen por stderr.
- **`manifest.json`:** el plugin, la CLI y el helper de Jest lo leen (junto a los templates) para la región y `terminationProtection` de cada stack. Un `manifest.json` corrupto **lanza**; ausente (solo templates sueltos), esas partes no se evalúan.
- **Ids de reglas con dígitos** (`NX-S3-001`): si un script suyo valida los ids con `^NX-[A-Z]+-\d{3}$`, ajústelo a `^NX-[A-Z][A-Z0-9]*-\d{3}$`.

## Orden de adopción recomendado

1. Subir la versión en una rama y medir el impacto (arriba): una lista de hallazgos por stage.
2. Arreglar primero lo barato y sin riesgo: `NX-ECS-001`, `NX-LOG-001` (retenciones), `NX-S3-001`, `NX-PROT-001`.
3. Lo que lleva diseño: `NX-BKP-001` (plan + vault con lock + selección), `NX-WAF-001`.
4. Lo que se acepta con motivo: excepción declarada dos veces (`docs/exceptions.md`), con dueño y caducidad. **No admiten excepción:** el log group eterno o implícito, los hallazgos de `TerminationProtection` y las reglas v1 que ya no la admitían.
