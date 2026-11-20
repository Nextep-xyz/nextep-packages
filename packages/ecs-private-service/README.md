# @nextep/ecs-private-service

Construct L3 de CDK que instala, en un **cluster ECS Fargate existente**, un servicio HTTP **privado**: sin balanceador, sin IP pública, alcanzable solo por **Service Connect** desde los security groups que autorices. El repo consumidor lo instancia con sus props y no escribe nada más.

Es solo infraestructura: **la imagen que corre dentro no vive aquí**. El construct la referencia por URI de repositorio y digest (`<repositoryUri>@sha256:…`), y no la construye ni la publica.

## Instalación

El paquete **no está en ningún registry de npm**: se distribuye como tarball adjunto a un Release de GitHub. Se instala por URL, con la versión exacta, sin credenciales:

```json
"dependencies": {
  "@nextep/ecs-private-service": "https://github.com/<org>/nextep-packages/releases/download/ecs-private-service-v0.1.0/nextep-ecs-private-service-0.1.0.tgz"
}
```

El lockfile fija el hash del tarball. `aws-cdk-lib` (`>=2.275.0 <3`) y `constructs` (`^10`) son **`peerDependencies`**: el consumidor pone la única copia (dos copias de `aws-cdk-lib` rompen `instanceof` en silencio). El paquete no tiene `dependencies` de runtime.

## Uso

```ts
import { PrivateEcsService } from '@nextep/ecs-private-service';

const engine = new PrivateEcsService(this, 'Engine', {
  cluster,                                   // ecs.ICluster existente
  vpc,                                       // la VPC de ese cluster
  serviceName: 'my-engine',                  // nombre del servicio ECS y, por defecto, su DNS de Service Connect
  image: { repository, version: '1.4.1', digest: 'sha256:<64 hex>' },
  databaseUrlSecret,                         // secreto con la URL de conexión COMPLETA en el campo `url`
  serviceConnect: { namespace: namespaceArn },
  ingressFrom: [clientServiceSecurityGroup], // al menos uno
  extraSecurityGroups: [databaseAccessSecurityGroup],
  appKey: { applicationId: 'MY_APP' },
  environment: 'production',
});

engine.endpointUrl;     // dentro del namespace, por HTTP: my-engine:8000/api/v1
engine.appKeyAsSecret() // ecs.Secret listo para la task de un cliente: secrets: { ENGINE_KEY: engine.appKeyAsSecret() }
```

## Props

| Prop | Obligatoria | Qué es |
|---|---|---|
| `cluster`, `vpc` | sí | Cluster existente y su VPC. |
| `serviceName` | sí | `^[a-z][a-z0-9-]{1,30}$`. |
| `image` | sí | `{ repository: ecr.IRepository, version, digest }`. `version` semver exacto (sin `latest`, rangos ni `v`); `digest` `sha256:` + 64 hex. El execution role recibe el pull. |
| `databaseUrlSecret`, `databaseUrlField?` | sí / `url` | La **URL de conexión completa**. El construct no conoce el schema ni crea roles: el consumidor aprovisiona el rol y fija su schema (p. ej. por `search_path`). |
| `serviceConnect` | sí | `{ namespace, dnsName? }`. El namespace es explícito porque un cluster importado no trae el suyo. |
| `ingressFrom` | sí (≥ 1) | Security groups que pueden llamar al servicio, solo al puerto del servicio. |
| `extraSecurityGroups?` | no | Se suman al del servicio (p. ej. el de acceso a la base de datos). |
| `appKey` | sí | `{ applicationId }` (`^[A-Z][A-Z0-9_-]{0,63}$`). |
| `environment` | sí | `development`, `staging` o `production`. |
| `port?`, `healthCheckPath?` | no | `8000` y `/api/v1/health`. |
| `migrateCommand?`, `startCommand?` | no | `alembic upgrade head` y `uvicorn app.main:app --host 0.0.0.0 --port <port>`. Cada argumento debe ser una palabra sin metacaracteres de shell. |
| `sizing?` | no | `cpu` (512), `memoryMiB` (1024), `startPeriodSeconds` (180, máximo 300). |
| `logRetention?`, `alarmTopic?` | no | Un mes por defecto; con tópico, alarmas de CPU y memoria. |
| `extraEnvVars?` | no | Solo variables **no secretas**. Las reservadas se rechazan. |
| `removalPolicy?` | no | Del secreto de clave y del log group. Por defecto `RETAIN`. |

## Qué crea

- Task definition Fargate X86_64 y servicio en subredes privadas, sin IP pública, con circuit breaker y rollback.
- Un security group propio: ingress solo desde `ingressFrom`, solo TCP al puerto del servicio.
- Un secreto de clave generado en cada instalación, `{"<applicationId>": "<64 caracteres>"}`, que se inyecta **entero** como `EMBEDDED_APPLICATIONS`. Nunca está en claro en el template.
- Variables no secretas: `ENVIRONMENT`, `ENGINE_VERSION`, `IMAGE_DIGEST`, `PYTHONDONTWRITEBYTECODE`. Secretos (siempre por `secrets`, nunca por `environment`): `DATABASE_URL` y `EMBEDDED_APPLICATIONS`.
- Log group con retención. Alarmas de CPU y memoria si das un tópico.
- **IAM mínimo:** el task role **no tiene permisos** (el servicio no llama a AWS). El execution role solo hace pull de la imagen, escribe logs y lee los dos secretos.
- Contenedor con filesystem raíz de solo lectura y `/tmp` como único volumen escribible; health check con Python de la biblioteca estándar (las imágenes `-slim` no traen `curl`).

## Excepción declarada: migración al arrancar (A1, caduca 2026-12-31)

El comando del contenedor es `<migrateCommand> && exec <startCommand>` y el servicio despliega con `minimumHealthyPercent 0` y `maximumPercent 100`, de modo que **nunca hay dos tasks migrando a la vez**. El costo es un corte breve en cada deploy; el periodo de gracia por defecto (180 s) cubre la migración. No hay props para aflojarlo. El sustituto previsto es una task one-off previa al servicio, con una prueba de compatibilidad de migraciones entre N y N-1. La excepción se declara dos veces (marca en el código y entrada con caducidad en `docs/exceptions.yml` del repo).

## Guards (cada uno es un test que bloquea el build)

| # | Guard |
|---|---|
| L1 | `version` semver exacto y `digest` `sha256:` válidos |
| L2 | Sin secretos en claro; la clave generada tiene ≥ 32 caracteres |
| L3 | Red privada: sin ingress `0.0.0.0/0`, sin IP pública, `ingressFrom` obligatorio |
| L4 | IAM mínimo: task role sin policies; sin `*` salvo `ecr:GetAuthorizationToken` |
| L5 | Claves reservadas rechazadas en `extraEnvVars` |
| L6 | Migración sin solape (`0 / 100`) |
| L7 | Filesystem de solo lectura, health check sin `curl`, circuit breaker con rollback |
| L8 | Service Connect con namespace y `appProtocol http` |
| L9 | `aws-cdk-lib` y `constructs` solo como `peerDependencies` (marcados opcionales para que pnpm no los auto-instale) |

## Desarrollo (monorepo `nextep-packages`)

- Los imports **dentro de `src/` son relativos a propósito**: el paquete se distribuye compilado con `tsc` y los alias no sobreviven.
- `private: true` es **intencional y permanente**: se distribuye por Release, nunca por `npm publish`.
- El template sintetizado con props mínimas está en un fixture JSON versionado (`test/fixtures/minimal.template.json`; no un `.snap` de Jest, cuya cabecera lleva una URL que el gate público rechaza): un cambio en él debe verse en el review. Se regenera con `UPDATE_TEMPLATE_FIXTURE=1 pnpm test`.

## Licencia

Apache-2.0 (ver `LICENSE` y `NOTICE`). Se ofrece «tal cual», sin garantía de ningún tipo.
