# NX-COST-002 — RDS nunca `micro` ni `nano`

| | |
|---|---|
| **Severidad** | `error` |
| **Aplica en** | `dev`, `stg`, `prod`, `shared` |
| **Excepción** | Sí (declarada dos veces, con caducidad) |

## Qué verifica

Ningún `AWS::RDS::DBInstance` tiene un `DBInstanceClass` que termine en `.micro` o `.nano` (sin distinguir mayúsculas). Si la clase no es un literal (depende de un `Ref` o similar) la regla **la reporta**: no puede comprobar nada y no debe pasar en silencio.

## Por qué

El 2026-10-05 `db.t4g.micro` (y `medium`) no eran ordenables en `us-east-1` y una instancia de dev no pudo arrancar. La lección vivía en un **comentario** de un repo, y otro proyecto la repitió como tipo. Aquí se hace cumplir en el template, no en la memoria de alguien.

## Cómo corregirlo

Usar `db.t4g.small` o mayor. Antes del primer deploy en una región nueva, comprobar la ordenabilidad (`aws rds describe-orderable-db-instance-options --engine postgres --engine-version 16 --db-instance-class <clase> --region <región> --output json`): esta regla solo descarta las clases conocidas como problemáticas, no garantiza que la clase elegida sea ordenable (verificación online: subcomando `preflight`, aún no implementado).

## De dónde viene

Un incidente real de aprovisionamiento (2026-10-05) y su réplica en un segundo proyecto; la versión local se verificó en rojo.

## Límites conocidos

- Aurora Serverless v2 (`db.serverless`) no se ve afectada. Las instancias `.micro`/`.nano` de Aurora no existen, así que no hay falso negativo.
- La regla mira `AWS::RDS::DBInstance`; los clústeres Aurora (`AWS::RDS::DBCluster`) no declaran clase.
