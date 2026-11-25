# Modo de ejecución: `NEXTEP_GUARDRAILS_MODE`

Desde `0.3.0` el paquete lee una variable de entorno para decidir si una violación con severidad `error` **bloquea** (`enforce`) o se **reporta como aviso** (`warn`). Sin la variable, nada cambia respecto a `0.2.0`: la salida de la CLI es idéntica byte a byte.

## Contrato

| `NEXTEP_GUARDRAILS_MODE` | Modo efectivo | Aviso |
|---|---|---|
| ausente, cadena vacía | `enforce` | no |
| `enforce` | `enforce` | no |
| `warn` | `warn` | no |
| cualquier otro valor (incluidos `WARN`, `warn ` y `off`) | `enforce` | sí, por stderr |

La comparación es exacta y distingue mayúsculas: un valor mal escrito **nunca** relaja el gate.

## Qué cambia en `warn`

| Adaptador | Violación `error` en `enforce` | En `warn` |
|---|---|---|
| CLI | `ERROR …`, `::error`, exit 1 | `WARN [downgraded from error] …`, `::warning`, exit 0; el resumen de GitHub declara el modo y marca la fila «aviso (degradado de error)» |
| Plugin de CDK | `success: false`, severidad `error`, el synth aborta | `success: true`, severidad `warning`, la descripción empieza por `[downgraded from error]`; el synth no falla |
| Helper de Jest | lanza | escribe por stderr y no lanza |

El plugin lee la variable al sintetizar (en `validate`), no al construirse: el valor que cuenta es el del proceso que hace el `synth`.

## Qué no cambia

- `NX-EXC-001..004` (higiene de excepciones: marca sin entrada, entrada obsoleta o vencida, regla que no admite excepción) **siguen siendo error en ambos modos**. Una excepción rota es un defecto de gobierno, no una violación de costo.
- Los usos incorrectos de la CLI (`--out` ausente, `cdk.out` sin templates…) siguen saliendo con código 2.
- Las reglas, sus severidades y el formato de las excepciones.
- No existe una opción en código (`installGuardrails`, `expectNextepCompliant`) ni un flag de la CLI para fijar el modo: la variable de entorno es la única costura, y la controla quien ejecuta el pipeline.

## Programático

```ts
import { applyMode, resolveMode } from '@nextep/cdk-guardrails';

const { mode, invalid } = resolveMode(process.env); // invalid: texto del aviso si el valor era basura
const reported = applyMode(violations, mode);        // 'warn' marca las degradadas con `downgraded: true`
```
