# NX-POWER-002 — En `dev` y `stg` los servicios Fargate bajan a 0

| | |
|---|---|
| **Severidad** | `error` |
| **Aplica en** | `dev`, `stg` |
| **Excepción** | Sí (declarada dos veces, con caducidad) |

## Qué verifica

Todo `AWS::ECS::Service` Fargate (`LaunchType: FARGATE`, o una `CapacityProviderStrategy` con `FARGATE`/`FARGATE_SPOT`) tiene, **en el mismo template**, un `AWS::ApplicationAutoScaling::ScalableTarget` que lo referencia (por `Fn::GetAtt` o `Ref` en `ResourceId`) y que puede dejarlo en 0: `MinCapacity: 0`, o una acción programada con `MaxCapacity: 0`. Los servicios EC2 no entran. Un `ScalableTarget` de otro template no cuenta.

## Por qué

Un servicio Fargate de dev que corre 24/7 es costo puro fuera del horario de trabajo. El apagado de la BD (NX-POWER-003) sin el de las tasks además deja a las tasks en crashloop contra una BD apagada. La regla exige que el mecanismo **exista**; la ventana exacta es del proyecto.

## Cómo corregirlo

Registrar el servicio con `scaleOnSchedule` y `minCapacity: 0` en dev/stg, con una ventana definida por el proyecto (o un módulo de apagado programado equivalente). Si el servicio realmente no puede apagarse, declarar la excepción (marca `nextep:exception` en el servicio + entrada en `governance/exceptions.yml`).

## De dónde viene

Un gotcha de costo repetido en proyectos con Fargate. Forma real en el synth: `ScalableTarget` con `MinCapacity: 0` y `ScheduledActions` `PowerOn`/`PowerOff`.

## Límites conocidos

- No se comprueba que la ventana sea correcta ni que arranque a tiempo: solo que el servicio *puede* bajar a 0.
- No se evalúa en `prod` (ahí manda NX-POWER-001).
