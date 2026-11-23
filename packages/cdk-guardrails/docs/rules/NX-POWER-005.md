# NX-POWER-005 — En `prod` todo servicio ECS tiene capacidad mínima de 1

| | |
|---|---|
| **Severidad** | `error` |
| **Aplica en** | `prod` |
| **Excepción** | Sí (declarada dos veces, con caducidad) |
| **Falla cerrado** | Sí (caso «no resoluble») |

## Qué verifica

En `prod`, para todo `AWS::ECS::Service`:

1. `DesiredCount`, si está declarado, es un literal **>= 1**. **Ausente es válido**: ECS usa 1 (CDK lo omite a propósito cuando el servicio tiene autoescalado, para no pisarlo en cada deploy). Un servicio con `SchedulingStrategy: DAEMON` no usa `DesiredCount` y no se juzga.
2. Cada `AWS::ApplicationAutoScaling::ScalableTarget` cuyo `ResourceId` apunta al servicio (por `Ref`/`GetAtt` local o a través de un export de otro stack) tiene `MinCapacity` literal **>= 1** y ninguna acción programada (`ScheduledActions[].ScalableTargetAction.MinCapacity`) que lo baje de 1.

Los ScalableTarget que no son de un servicio ECS del app (p. ej. concurrencia aprovisionada de Lambda) no son sujeto.

**No resoluble (falla cerrado):** un `DesiredCount`, `MinCapacity` o `MinCapacity` de acción programada que sea un intrinsic se **reporta**: no se puede demostrar que sea >= 1.

## Relación con `NX-POWER-001` y `NX-POWER-002`

| Regla | Qué mira | Excepción |
|---|---|---|
| `NX-POWER-001` (prod) | **Mecanismos** de apagado: schedules de stop, `MinCapacity: 0`, acciones a `MaxCapacity: 0` | **No** |
| `NX-POWER-005` (prod) | **Capacidad mínima**: `DesiredCount` >= 1, `MinCapacity` >= 1, acciones con `MinCapacity` >= 1 | Sí |
| `NX-POWER-002` (dev, stg) | Los servicios Fargate **deben poder** bajar a 0 | Sí |

Se solapan en `MinCapacity: 0` a propósito: cada regla es autocontenida (si una cambia, la otra sigue protegiendo) y **ambas** reportan. La excepción de `NX-POWER-005` **no** levanta `NX-POWER-001`: el motor las juzga por separado. `NX-POWER-002` no aplica en `prod`, así que no hay contradicción: un servicio de `prod` conforme pasa 001 y 005.

## Por qué

`NX-POWER-001` impide que `prod` se apague por un mecanismo conocido, pero no exige que haya algo corriendo: un `DesiredCount: 0` heredado de una plantilla de `dev` deja `prod` caído sin que ningún schedule intervenga.

## Cómo corregirlo

Subir `desiredCount` a 1 o más, o quitarlo si hay autoescalado; y `minCapacity: 1` o más en `autoScaleTaskCount`. Si un servicio de `prod` se apaga a propósito, no es una excepción de esta regla: `NX-POWER-001` lo prohíbe sin excepción.

## De dónde viene

El mismo gotcha que `NX-POWER-001` (la configuración de dev se copia a prod), visto por el otro lado: no el mecanismo, sino el resultado.

## Límites conocidos

- `DesiredCount` ausente se acepta (default 1); si un servicio real tuviera un default distinto, la regla no lo vería.
- Una acción programada con `MaxCapacity: 0` y sin `MinCapacity` la reporta `NX-POWER-001`, no esta.
