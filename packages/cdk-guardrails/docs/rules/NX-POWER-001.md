# NX-POWER-001 — En `prod` no existe ningún apagado

| | |
|---|---|
| **Severidad** | `error` |
| **Aplica en** | `prod` |
| **Excepción** | **No** admite (decisión de diseño) |

## Qué verifica

En `prod`:

1. Ningún `AWS::Scheduler::Schedule` tiene como target universal (`arn:…:scheduler:::aws-sdk:<servicio>:<acción>`) una de estas acciones: `rds:stopDBInstance`, `rds:stopDBCluster`, `ec2:stopInstances`, `ecs:updateService` (sin distinguir mayúsculas). Un schedule `DISABLED` **sigue contando**: se puede habilitar desde la consola.
2. Ningún `AWS::ApplicationAutoScaling::ScalableTarget` tiene `MinCapacity: 0`, ni una acción programada con `MaxCapacity: 0`.

Un target universal cuya acción no se puede resolver estáticamente se **reporta**: no puede hacer pasar la regla. Un target que no es universal (una Lambda por `Fn::GetAtt`) no se juzga.

## Por qué

Un `prod` que se apaga es una caída programada. Hoy nada comprueba que `prod` **no** se apague: lo único que lo impide es que alguien no copie la ventana de dev. La regla no admite excepción porque no hay un caso legítimo; si lo hubiera, es un cambio de la regla, no de un proyecto.

## Cómo corregirlo

Quitar el schedule o el escalado a 0 del stage `prod`. Una buena defensa en compilación es un tipo que excluya `prod` de los stages con apagado programado; esta regla es la segunda barrera, sobre el template final.

## De dónde viene

Un gotcha repetido: el apagado programado de dev se copia a prod sin darse cuenta. Formato del target verificado contra un synth real (`Target.Arn` es un `Fn::Join`, no un string).

## Límites conocidos

- **`ecs:updateService` se trata como apagado siempre**, también cuando el schedule lo usa para *subir* el `desiredCount` (prewarm). Es la lectura literal y conservadora; si aparece un caso real, la refinación es inspeccionar el `Input` (`desiredCount`). Candidato de v1.1.
- Un `ScalableTarget` con `MinCapacity: 0` que no es de ECS (p. ej. concurrencia aprovisionada de Lambda) también se reporta: la regla no mira `ScalableDimension`.
- Los schedules de `AWS::Events::Rule` no se leen.
