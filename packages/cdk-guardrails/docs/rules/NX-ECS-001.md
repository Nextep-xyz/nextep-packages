# NX-ECS-001 — Todo servicio ECS lleva circuit breaker con rollback

| | |
|---|---|
| **Severidad** | `error` |
| **Aplica en** | `dev`, `stg`, `prod` y `shared` |
| **Excepción** | Sí (declarada dos veces, con caducidad) |
| **Falla cerrado** | Sí (caso «no resoluble») |

## Qué verifica

Todo `AWS::ECS::Service` con controlador de despliegue ECS (`DeploymentController.Type: ECS` o ausente, que es el default) tiene `DeploymentConfiguration.DeploymentCircuitBreaker` con `Enable: true` **y** `Rollback: true`.

No son sujeto: los servicios con `DeploymentController.Type` `CODE_DEPLOY` o `EXTERNAL` (el despliegue lo gobierna otro servicio) ni los que declaran `DeploymentConfiguration.Strategy` distinta de `ROLLING` (blue/green o canary nativos de ECS: el circuit breaker es del despliegue rodante; supuesto conservador, ver el spec).

**No resoluble (falla cerrado):** si `DeploymentController.Type`, `DeploymentConfiguration`, `Strategy`, `DeploymentCircuitBreaker`, `Enable` o `Rollback` son un intrinsic (`Ref` a un parámetro, `Fn::If`…), el motor no puede demostrar que el breaker está activo y lo **reporta** con el mensaje «no se puede comprobar». Declare el valor literal.

## Por qué

Sin circuit breaker, un despliegue cuyas tasks nunca llegan a estable se queda reintentando indefinidamente: el deploy no termina, el rollback es manual y, según los porcentajes, el servicio que sigue sirviendo puede ser el roto. Con `Rollback: true` ECS vuelve solo a la última versión estable. Es una barrera de equipo, no de ambiente: por eso corre también en `dev` y `stg`.

## Cómo corregirlo

En CDK:

```ts
new ecs.FargateService(this, 'Service', {
  cluster, taskDefinition,
  circuitBreaker: { rollback: true },
});
```

Con L1: `deploymentConfiguration: { deploymentCircuitBreaker: { enable: true, rollback: true } }`.

## De dónde viene

Un despliegue roto en un ambiente sin breaker se queda en `IN_PROGRESS` hasta que alguien lo nota. El estándar de infra lo pide en todo servicio; esta regla lo vuelve un test.

## Límites conocidos

- `Strategy` distinta de `ROLLING` se omite (supuesto conservador: no hay certeza de que el circuit breaker aplique al blue/green nativo). Si aparece un caso real, se afina.
- No juzga `DeploymentConfiguration.Alarms` (rollback por alarmas de CloudWatch): es complementario, no sustituto.
