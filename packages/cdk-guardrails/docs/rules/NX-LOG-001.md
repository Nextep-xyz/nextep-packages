# NX-LOG-001 — Ningún log group eterno y todos con techo de retención

| | |
|---|---|
| **Severidad** | `error` |
| **Aplica en** | `dev`, `stg`, `prod` y `shared` |
| **Excepción** | **Parcial, por hallazgo** (ver la tabla): el log group eterno **no** admite excepción; el exceso sobre el techo y un destino externo sí (declarada dos veces, con caducidad) |
| **Falla cerrado** | Sí (caso «no resoluble») |

## El techo

**`MAX_LOG_RETENTION_DAYS = 365` días.** Es la única constante del paquete para esto (exportada por `src/rules/NX-LOG-001.ts`, junto con `CW_RETENTION_VALUES`).

CloudWatch Logs solo acepta estos valores de `RetentionInDays`: `1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653`. Cualquier otro lo rechaza el deploy; la regla lo reporta antes. **Por qué 365:** un año cubre la auditoría operativa y el análisis interanual de incidentes; por encima, el costo de almacenamiento crece sin que el dato se consulte. Quien necesite más (cumplimiento, auditoría) lo declara con excepción y caducidad.

## Qué verifica

### Política de excepción (por hallazgo)

| Hallazgo | Excepción |
|---|---|
| **Sin retención** (eterno): log group o `Custom::LogRetention` sin `RetentionInDays`; valor no válido (≤ 0 o fuera de la lista) | **No** |
| **Origen implícito** (el servicio crea el log group solo, y el app no declara uno con retención) | **No** |
| **Excede el techo** (valor válido > 365) | Sí |
| **Destino externo o no resoluble** (el log group no es del app; un `RetentionInDays` que es un intrinsic) | Sí: el responsable atestigua dónde se gobierna |

Un log group eterno es un defecto con arreglo de una línea; aceptarlo con una excepción solo lo perpetúa. Una marca `nextep:exception` + entrada vigente sobre un hallazgo que no admite excepción **no lo silencia**: el hallazgo sigue y dice que no la admite.

### Orígenes cubiertos

1. **`AWS::Logs::LogGroup` y `Custom::LogRetention`:** `RetentionInDays` presente, válido y <= techo.
2. **`AWS::Lambda::Function`** sin log group explícito. La función tiene log group si `LoggingConfig.LogGroup` resuelve a un `AWS::Logs::LogGroup` del app, **o** el app declara un log group (o `Custom::LogRetention`) llamado `/aws/lambda/<la función>` (por `Ref` o por `FunctionName` literal). Si no, **el grupo implícito `/aws/lambda/<fn>` que Lambda crea al ejecutarse queda eterno**. Esta es la trampa que atrapa a las Lambdas que CDK crea por ti: el framework de `cr.Provider`, la Lambda auxiliar de `Custom::LogRetention`, `AwsCustomResource` y los `CustomResourceProvider` internos. El mensaje identifica cuál es por la ruta de CDK y dice cómo arreglarlo.
3. **RDS/Aurora `EnableCloudwatchLogsExports`:** cada log exportado crea `/aws/rds/instance/<id>/<tipo>` (o `/cluster/`); el app debe declarar un log group (o `Custom::LogRetention`) con ese nombre.
4. **CodeBuild:** sin `LogsConfig.CloudWatchLogs` (y sin `Status: DISABLED`) crea `/aws/codebuild/<proyecto>`; con `GroupName` explícito se resuelve.
5. **ECS (`awslogs`):** `awslogs-group` de cada contenedor y del log del Service Connect debe resolver a un log group del app; con `awslogs-create-group: true` y sin declararlo, es implícito.
6. **API Gateway:** el destino del access log (`AccessLogSetting` v1, `AccessLogSettings` v2) y el log de ejecución implícito `API-Gateway-Execution-Logs_<api>/<stage>` cuando `MethodSettings` usa `LoggingLevel` `ERROR` o `INFO`.
7. **Step Functions** (`LoggingConfiguration.Destinations`) y **VPC Flow Logs** con destino `cloud-watch-logs`: el destino debe resolver a un log group del app.

**No resoluble (falla cerrado):** un `RetentionInDays` o una configuración que es un intrinsic, o un destino que no es un log group del app, se **reporta** («no se puede comprobar») y admite excepción.

### Orígenes NO cubiertos (documentados)

No se pueden detectar con fiabilidad desde el template, o detectarlos sería una lista ad hoc: **Cognito** (log delivery), **AppSync**, **DocumentDB/Neptune** (`EnableCloudwatchLogsExports`), **Route 53** query logging, **CloudTrail**, **Lambda@Edge** (logs en la región de cada réplica), **Glue**, **DMS**, **EKS**, **WAF** logging a CloudWatch, y cualquier log group que el código de la aplicación cree en tiempo de ejecución. Ampliar la cobertura es un cambio menor con su fixture.

## Por qué

Un log group sin retención **no expira nunca**: el costo de almacenamiento crece sin tope y silenciosamente, y el dato más viejo (que casi nadie consulta) puede contener información personal que no debería conservarse indefinidamente. La mayoría de los eternos no los escribe nadie: los crea implícitamente un servicio (Lambda, RDS, CodeBuild) la primera vez que ejecuta, y por eso una regla de «los `LogGroup` del template tienen retención» no basta.

## Cómo corregirlo

```ts
const logGroup = new logs.LogGroup(this, 'Logs', { retention: logs.RetentionDays.ONE_MONTH });
new lambda.Function(this, 'Fn', { /* … */ logGroup });                 // en vez de logRetention (deprecado)
new cr.Provider(this, 'Provider', { onEventHandler, logGroup });        // el framework del Provider
new rds.DatabaseInstance(this, 'Db', { /* … */ cloudwatchLogsExports: ['postgresql'], cloudwatchLogsRetention: logs.RetentionDays.THREE_MONTHS });
```

Para un `CustomResourceProvider` interno de CDK (sin prop de log group): declare un `logs.LogGroup` con `logGroupName` `/aws/lambda/${cfnFunction.ref}` y retención.

## De dónde viene

Los log groups implícitos son el origen principal de logs eternos en una cuenta de AWS gestionada con CDK; los de las Lambdas de custom resources pasan desapercibidos porque nadie los escribe. Se verificó contra synths reales: el framework de un `cr.Provider` solo declara su log group (por nombre, `/aws/lambda/<función>`) cuando se le pide retención; sin ella, igual que el helper de `Custom::LogRetention` y los `CustomResourceProvider` internos, deja el grupo implícito.

## Límites conocidos

- El log group **declarado** se juzga solo por su retención; no se mira su cifrado ni su clase.
- Un log group que el app declara con un nombre que el motor no puede componer (con un intrinsic distinto de `Ref`/`GetAtt`) no se reconoce como el de una Lambda o de RDS: se reporta el implícito. Referencie la función con `Ref` en el nombre, o use `LoggingConfig.LogGroup`.
- Las Lambdas declaradas en un stack y su log group en otro solo se emparejan si la función tiene `FunctionName` literal.
