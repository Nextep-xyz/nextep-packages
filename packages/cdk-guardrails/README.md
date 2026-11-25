# @nextep/cdk-guardrails

Guardarrailes de costo y estándar para proyectos CDK. Un **motor puro** evalúa los templates de CloudFormation sintetizados (`cdk.out/*.template.json`) y reporta violaciones que nombran **regla, stack y recurso**. Sin red, sin `eval`, sin dependencias de runtime.

## Instalación

El paquete **no está en ningún registry de npm**: se distribuye como tarball adjunto a un Release de GitHub. Se instala por URL, con la versión exacta, sin credenciales:

```json
"devDependencies": {
  "@nextep/cdk-guardrails": "https://github.com/<org>/nextep-packages/releases/download/cdk-guardrails-v0.1.1/nextep-cdk-guardrails-0.1.1.tgz"
}
```

El lockfile fija el hash del tarball. Versión exacta siempre: una regla nueva en `error` es un cambio **mayor** y puede romper el build de un proyecto.

## Una fuente de reglas, tres puntos de entrada

| Adaptador | Uso | Cuándo corre | Se puede saltar |
|---|---|---|---|
| **Plugin** de policy validation | `installGuardrails(app, { stage: 'dev', exceptionsFile })` | cada `cdk synth` y `cdk deploy`, local y CI | Sí (`--ignore-errors`, `--app cdk.out`, construir el `App` sin él) |
| **Helper de Jest** | `expectNextepCompliant(app, { stage: 'dev' })` | `pnpm test` del proyecto (required status check) | No, si el job es required |
| **CLI** | `nextep-guardrails check --out cdk.out --stage dev` | job de CI, **independiente del código del proyecto** | No: evalúa lo que se va a desplegar |

La CLI es la red de seguridad: no confía en que el proyecto haya instalado nada.

```ts
// infra/lib/app.ts
import { installGuardrails } from '@nextep/cdk-guardrails';
const app = new App();
installGuardrails(app, { stage, sharedStacks: ['MiDominio'], exceptionsFile: 'governance/exceptions.yml' });
```

```powershell
# Revisar un cdk.out ya generado (exit 1 si hay violaciones con severidad error; los avisos NO cuentan)
nextep-guardrails check --out infra/cdk.out --stage dev --exceptions governance/exceptions.yml
nextep-guardrails --list-rules
```

### Avisos y GitHub Actions

Las reglas con severidad `warn` (marcadas **Aviso** en el catálogo) **nunca** hacen fallar la CLI, el plugin ni el helper de Jest: la CLI las imprime como `WARN`, el plugin las reporta a CDK con severidad `warning` y el helper de Jest las escribe por stderr.

Dentro de GitHub Actions, la CLI se autodetecta (`GITHUB_ACTIONS=true`) y emite **anotaciones** (`::warning title=<regla>::<mensaje>` y `::error …`) que aparecen en amarillo/rojo en el resumen del run; `--format text` lo desactiva y `--format github` lo fuerza. Si existe `GITHUB_STEP_SUMMARY`, además **anexa una tabla Markdown** con todas las violaciones (GitHub muestra como máximo 10 anotaciones de cada tipo por step: la tabla es el listado completo).

### Modo: `NEXTEP_GUARDRAILS_MODE` (desde 0.3.0)

Una variable de entorno, pensada para que el **pipeline** (no cada repo) decida qué hacer con las violaciones `error`. Los tres adaptadores la leen igual; no hay opción equivalente en código ni flag en la CLI.

| Valor | Efecto |
|---|---|
| ausente, vacío o `enforce` | Comportamiento de siempre: una violación `error` hace fallar (CLI exit 1, helper de Jest lanza, el plugin aborta el synth). |
| `warn` | Las violaciones `error` se reportan **como aviso** y no hacen fallar (exit 0). CLI: `WARN [downgraded from error]`, anotación `::warning` y tabla del resumen marcada «degradado de error». Plugin: severidad `warning` de CDK. Helper de Jest: stderr, sin lanzar. |
| cualquier otro valor (`Warn`, `warn `, `off`…) | Se trata como `enforce` y se avisa por stderr (fail-closed: un typo nunca relaja). |

Lo que **no** cambia en ningún modo: las violaciones de higiene de excepciones `NX-EXC-001..004` (marca sin entrada, entrada obsoleta o vencida, regla que no admite excepción) **siguen siendo error**: una excepción rota es un defecto de gobierno, no de costo. Tampoco cambian los usos incorrectos de la CLI (exit 2), las reglas ni sus severidades. Más detalle en `docs/mode.md`.

```powershell
$env:NEXTEP_GUARDRAILS_MODE = 'warn'
nextep-guardrails check --out infra/cdk.out --stage prod   # exit 0; los errores salen como WARN [downgraded from error]
```

## Catálogo

`nextep-guardrails --list-rules` lo imprime. Cada regla tiene su doc en `docs/rules/<id>.md` (qué verifica, por qué, cómo corregirlo, de dónde viene, límites conocidos).

| Id | Qué |
|---|---|
| `NX-FIN-001` | Tags `Project`/`Application`/`Environment` y `Environment` = stage |
| `NX-COST-001` | Sin `AWS::CloudWatch::Dashboard` |
| `NX-COST-002` | RDS nunca `micro` ni `nano` |
| `NX-COST-003` | Container Insights solo en `prod` |
| `NX-POWER-001` | En `prod` no existe ningún apagado |
| `NX-POWER-002` | En `dev`/`stg` los servicios Fargate bajan a 0 |
| `NX-POWER-003` | En `dev`/`stg` la RDS tiene stop y start programados |
| `NX-POWER-004` | El stop de RDS no corre todos los días |
| `NX-POWER-005` | En `prod` todo servicio ECS tiene `DesiredCount` y `MinCapacity` >= 1 |
| `NX-ECS-001` | Todo servicio ECS tiene circuit breaker con rollback (todos los stages) |
| `NX-PROT-001` | En `prod`: `DeletionProtection` en RDS/Aurora y ALB, `TerminationProtection` en los stacks |
| `NX-S3-001` | En `prod`: todo bucket con versioning, bloqueo público completo y TLS obligatorio |
| `NX-BKP-001` | En `prod`: RDS con PITR (>= 7 días) y un BackupPlan cuyo vault tiene Vault Lock |
| `NX-BKP-002` | **Aviso.** La RDS tiene copia de respaldo a otra región (con o sin plan) |
| `NX-WAF-001` | En `prod`: todo ALB internet-facing tiene una WebACL asociada |
| `NX-WAF-002` | **Aviso.** La WebACL no está solo en count y tiene logging |
| `NX-ALM-001` | **Aviso.** Todo topic usado como destino de alarmas tiene al menos un suscriptor |
| `NX-LOG-001` | Ningún log group eterno y todos con techo de 365 días, incluidos los implícitos (todos los stages) |

Excepciones: `docs/exceptions.md`. **No existe forma de desactivar una regla** salvo una excepción declarada dos veces y con caducidad.

**Actualizar desde 0.1.x:** las reglas `error` nuevas (todas menos `NX-BKP-002`, `NX-WAF-002` y `NX-ALM-001`) pueden romper el build de un proyecto existente. Ver `docs/migration-0.2.0.md`: qué regla, qué falla típicamente y cómo arreglarlo.

## Contexto de evaluación

`stage` (`dev|stg|prod|shared`) es **explícito**: nunca se infiere del nombre del stack. Un mismo synth puede mezclar stacks con ambiente y stacks sin ambiente (un dominio compartido): estos últimos se declaran en `sharedStacks` (`--shared-stacks` en la CLI).

## Desarrollo (monorepo `nextep-packages`)

- Los imports **dentro de `src/` son relativos a propósito**: el paquete se publica compilado con `tsc` y los alias de tsconfig (`@guardrails/*`) no sobreviven a la compilación. Los tests y los gates usan el alias.
- `pnpm --filter @nextep/cdk-guardrails build` compila a `dist/`. El bin falla con un mensaje claro si falta `dist/`.
- `private: true` es **intencional y permanente**: el paquete se distribuye por Release, nunca por `npm publish`. `npm pack` y la instalación por URL funcionan igual.
- `peerDependencies` (`aws-cdk-lib >=2.275.0 <3`, `constructs ^10`) y **ningún registry fijado en el manifiesto**: los gates GR6–GR8 (`governance/gates/guardrails-package.spec.ts` y `packages-shape.spec.ts`) lo hacen cumplir sobre el tarball real.
- Límite de v1: los `cdk.out` con assemblies anidados (apps con `Stage`) no se evalúan; la CLI sale con código 2 en vez de pasar sin haberlos leído.

## Licencia

[Apache-2.0](LICENSE): uso, modificación y redistribución libres. Se ofrece «tal cual», sin garantía; Nextep no responde por bugs ni retrasos que cause su uso. Sin derecho sobre el nombre ni las marcas de Nextep. Avisos en [NOTICE](NOTICE).
