# NX-POWER-004 — El stop de RDS no corre todos los días

| | |
|---|---|
| **Severidad** | `error` |
| **Aplica en** | `dev`, `stg` |
| **Excepción** | **No** admite |

## Qué verifica

Todo `AWS::Scheduler::Schedule` con target universal `rds:stopDBInstance` tiene una `ScheduleExpression` que **restringe el día de la semana**:

- `cron(30 20 ? * MON-FRI *)` ✅ · `cron(0 22 ? * SAT,SUN *)` ✅ · `at(…)` ✅ (una sola vez).
- `cron(0 20 * * ? *)` ❌ (todos los días) · `cron(0 21 ? * 1-7 *)` ❌ (los siete días escritos de otra forma) · `rate(…)` ❌.
- Una expresión que no se puede resolver a un literal o interpretar se **reporta**.

El campo día-de-la-semana se interpreta completo: nombres y números (SUN=1…SAT=7), listas, rangos (también los que dan la vuelta, `FRI-MON`), pasos (`*/2`) y `6L`/`FRI#3`. Si la unión de días cubre los siete, no restringe.

## Por qué

`StopDBInstance` **no es idempotente**: falla contra una instancia ya detenida. Si el stop corre sábado y domingo (la BD ya se detuvo el viernes y no arrancó), el schedule falla y enciende la alarma cada fin de semana. Los stops de workloads (`ecs:updateService`, `ec2:stopInstances`) sí son idempotentes y pueden correr todos los días: esta regla no los mira.

## Cómo corregirlo

Restringir el cron a L–V (`startWeekDays: 'MON-FRI'` en la ventana del proyecto), alineado con el start de la BD.

## De dónde viene

Un incidente operativo real: el stop diario de la BD enciende la alarma cada fin de semana. La única defensa era un comentario en el código de un proyecto.

## Límites conocidos

- Solo mira `stopDBInstance`. `stopDBCluster` (Aurora) tampoco es idempotente, pero v1 no lo incluye.
- No comprueba que el start y el stop caigan en los mismos días: solo que el stop no sea diario.
- No admite excepción: el comportamiento es del servicio de AWS, no una política que un proyecto pueda decidir.
