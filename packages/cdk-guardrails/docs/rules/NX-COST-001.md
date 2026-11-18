# NX-COST-001 — Sin dashboards de CloudWatch

| | |
|---|---|
| **Severidad** | `error` |
| **Aplica en** | `dev`, `stg`, `prod`, `shared` |
| **Excepción** | Sí (declarada dos veces, con caducidad) |

## Qué verifica

No existe ningún recurso `AWS::CloudWatch::Dashboard` en ningún stack del app.

## Por qué

Cada dashboard de CloudWatch cobra por dashboard y por mes. El problema real es que **nadie sabe que lo creó**: la regla es el guardarraíl para que nadie agregue uno sin saberlo. (No hay un constructo conocido que cree dashboards «por defecto»; lo que sí cobra sin pedirlo es Container Insights, que cubre NX-COST-003.)

## Cómo corregirlo

Quitar el `cloudwatch.Dashboard` y mostrar la métrica en la herramienta de observabilidad del equipo. Si el dashboard es imprescindible, declarar la excepción: marca `Metadata: { 'nextep:exception': ['NX-COST-001'] }` en el recurso **y** entrada en `governance/exceptions.yml` con `guard: NX-COST-001`, motivo, dueño y caducidad.

## De dónde viene

Una auditoría de costos de varios proyectos CDK mostró que cada uno reimplementaba esta comprobación a mano, con un test local que nadie sincroniza. La versión local se verificó en rojo: un `Dashboard` de prueba hizo fallar el gate nombrando los stacks.
