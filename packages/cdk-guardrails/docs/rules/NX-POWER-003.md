# NX-POWER-003 — En `dev` y `stg` la RDS tiene apagado y arranque programados

| | |
|---|---|
| **Severidad** | `error` |
| **Aplica en** | `dev`, `stg` |
| **Excepción** | Sí (declarada dos veces, con caducidad) |

## Qué verifica

Si el app contiene un `AWS::RDS::DBInstance` que no es Aurora Serverless v2 (`db.serverless`), existe **en algún stack del app** un `AWS::Scheduler::Schedule` habilitado con target universal `rds:stopDBInstance` **y** otro con `rds:startDBInstance`. Para una instancia que pertenece a un clúster Aurora aprovisionado (`DBClusterIdentifier` presente) se exigen `rds:stopDBCluster` y `rds:startDBCluster`. Un schedule `DISABLED` no cuenta. La violación se reporta sobre la instancia, nombrando su stack y su id.

## Por qué

Una RDS de dev prendida 24/7 es el mayor costo ocioso fuera del horario. Se verificó que el plugin de policy validation recibe **todos** los stacks del app en una sola invocación (dependientes y de otra región), así que el cruce entre el stack de la BD y el del schedule es fiable.

## Cómo corregirlo

Agregar el par start/stop programado, con `StopDBInstance` solo L–V (ver NX-POWER-004). Si la instancia no puede apagarse, excepción declarada dos veces.

## De dónde viene

Un gotcha de costo repetido en proyectos con RDS no serverless.

## Límites conocidos

- **Versión gruesa:** relaciona «hay una RDS» con «hay un schedule», no por identificador (si el schedule recibe el identificador por SSM, el template no lo vincula). Con dos RDS y un solo par de schedules pasa.
- Apps con `Stage` anidados (p. ej. CDK Pipelines): la validación puede correr por `Stage` y el cruce entre stages no se vería. NO VERIFICADO.
- La refinación Aurora aprovisionado (`stopDBCluster`) es la lectura correcta de la intención (AWS no admite `StopDBInstance` sobre Aurora).
