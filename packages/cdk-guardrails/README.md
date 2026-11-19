# @nextep/cdk-guardrails

Guardarrailes de costo y estándar para proyectos CDK. Un **motor puro** evalúa los templates de CloudFormation sintetizados (`cdk.out/*.template.json`) y reporta violaciones que nombran **regla, stack y recurso**. Sin red, sin `eval`, sin dependencias de runtime.

## Instalación

El paquete **no está en ningún registry de npm**: se distribuye como tarball adjunto a un Release de GitHub. Se instala por URL, con la versión exacta, sin credenciales:

```json
"devDependencies": {
  "@nextep/cdk-guardrails": "https://github.com/<org>/nextep-packages/releases/download/cdk-guardrails-v0.1.0/nextep-cdk-guardrails-0.1.0.tgz"
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
# Revisar un cdk.out ya generado (exit 1 si hay violaciones con severidad error)
nextep-guardrails check --out infra/cdk.out --stage dev --exceptions governance/exceptions.yml
nextep-guardrails --list-rules
```

## Catálogo (v1)

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

Excepciones: `docs/exceptions.md`. **No existe forma de desactivar una regla** salvo una excepción declarada dos veces y con caducidad.

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
