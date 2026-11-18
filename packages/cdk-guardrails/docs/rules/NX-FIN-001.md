# NX-FIN-001 — Tags de FinOps: `Project`, `Application` y `Environment`

| | |
|---|---|
| **Severidad** | `error` |
| **Aplica en** | `dev`, `stg`, `prod`, `shared` |
| **Excepción** | **No** admite |

## Qué verifica

Todo recurso del template que **tiene la propiedad `Tags`** lleva las tres claves `Project`, `Application` y `Environment`, con valor no vacío. Además `Environment` debe ser uno de `dev`, `stg`, `prod`, `shared` y **coincidir con el stage de la corrida** (`GuardrailsContext.stage`); en los stacks listados en `sharedStacks` debe ser `shared`.

Las claves distinguen mayúsculas: `project` no cuenta como `Project`, y el mensaje avisa de la clave en minúscula en vez de decir solo «falta». `Tags` se lee en las dos formas de CloudFormation (lista de `{Key,Value}` y mapa, p. ej. `AWS::SSM::Parameter`). `Project` y `Application` pueden ser un intrinsic (`Ref`); `Environment` debe ser un literal.

## Por qué

Los tags de cost allocation **no son retroactivos**: cada dialecto de clave parte el histórico de costos en dos. Es común encontrar tres dialectos para el mismo concepto: `Project`/`Application`/`Environment`, `project` en minúscula y un prefijo propio (`nextep:*`). Esta regla fija el trío como base obligatoria; un prefijo propio puede convivir como extensión.

## Cómo corregirlo

Aplicar el trío en el nivel del `App` o del `Stack` con `Tags.of(scope).add('Project', …)`, `Application` y `Environment` (valor = el stage). Para un stack sin ambiente (dominio, OIDC compartido), `Environment = 'shared'` **y** declarar su id en `sharedStacks`.

## De dónde viene

Una auditoría de cuatro proyectos mostró los tres dialectos. Un synth real mezcla stacks con ambiente y stacks sin ambiente (un dominio compartido), de ahí `sharedStacks`.

## Límites conocidos

- Un recurso **taggeable que no tiene la propiedad `Tags`** (el tag nunca se aplicó) **no es visible** para esta regla: el motor no conoce la tabla de tipos taggeables. Candidato de v1.1.
- Un `Tags` que es un intrinsic completo (`Fn::If`, `Ref`) no es evaluable y no se juzga.
- No admite excepción: una clave de FinOps ausente no es una decisión de proyecto, es un hueco en el reporte de costos.
