# NX-PROT-001 — En `prod`, protección contra borrado en RDS, ALB y stacks

| | |
|---|---|
| **Severidad** | `error` |
| **Aplica en** | `prod` |
| **Excepción** | Sí en RDS y ALB (declarada dos veces, con caducidad); **no** en el hallazgo de stack (no hay recurso donde marcarla) |
| **Falla cerrado** | Sí (caso «no resoluble») |

## Qué verifica

1. **RDS/Aurora:** todo `AWS::RDS::DBInstance` y `AWS::RDS::DBCluster` tiene `DeletionProtection: true`. Ausente equivale a `false` (default de CloudFormation) y es violación. Se omiten las instancias que pertenecen a un cluster (`DBClusterIdentifier`: la protección es del `DBCluster`) y las réplicas (`SourceDBInstanceIdentifier`, `ReplicationSourceIdentifier`): el dato primario es el que se protege.
2. **ALB:** todo `AWS::ElasticLoadBalancingV2::LoadBalancer` de tipo `application` (o sin `Type`) tiene el atributo `deletion_protection.enabled` = `true` en `LoadBalancerAttributes`. Los NLB y los balanceadores de gateway quedan fuera de esta versión.
3. **Stacks:** cada stack del synth lleva `TerminationProtection`.

### Sobre `TerminationProtection` (investigado)

El **template** de CloudFormation sintetizado **no** lo expone: es un parámetro de la API del stack, no una propiedad de un recurso. El **`manifest.json` del `cdk.out` sí** (`artifacts[<stack>].properties.terminationProtection`), y ese archivo existe cuando corre el plugin (se escribe antes de validar), la CLI y el helper de Jest. El motor lo recibe como `meta` de cada stack.

- **Sin ningún manifest** (uso exclusivo de templates sueltos), esta parte **no se evalúa**: los otros dos controles sí.
- **Con manifest**, un stack que no figura en él falla cerrado («no se puede comprobar»).
- **Alcance: todos los stacks del synth de `prod`**, incluidos los sin ambiente (dominio compartido).
- El hallazgo de stack se informa como `<stack>/(stack)` y **no admite excepción**.

**No resoluble (falla cerrado):** `DeletionProtection`, `Type`, `LoadBalancerAttributes` o el valor del atributo como intrinsic se **reportan**.

## Por qué

Un `terraform destroy`/`cdk destroy`/click equivocado sobre una base de datos o un balanceador de prod es una caída o una pérdida de datos; la protección cuesta una propiedad y convierte el borrado en un acto deliberado en dos pasos.

## Cómo corregirlo

```ts
new rds.DatabaseInstance(this, 'Db', { /* … */ deletionProtection: true });
new elbv2.ApplicationLoadBalancer(this, 'Alb', { vpc, deletionProtection: true });
new Stack(app, 'Db-Prod', { terminationProtection: true });
```

Para borrar de verdad un recurso protegido: primero se desactiva la protección en un cambio revisado, y después se borra.

## De dónde viene

Estándar de producción de Nextep: lo que tiene estado o da la cara no debe poder borrarse sin dos acciones deliberadas.

## Límites conocidos

- NLB y gateway: fuera de alcance (candidato en el spec, Q5).
- Un stack de prod desechable no tiene excepción: si es desechable, no debería estar en el synth de `prod`.
- No verifica `DeletionPolicy`/`UpdateReplacePolicy` de CloudFormation (otra capa de protección).
