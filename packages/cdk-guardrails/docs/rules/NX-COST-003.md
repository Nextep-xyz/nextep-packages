# NX-COST-003 — Container Insights solo en `prod`

| | |
|---|---|
| **Severidad** | `error` |
| **Aplica en** | `dev`, `stg` |
| **Excepción** | Sí (declarada dos veces, con caducidad) |

## Qué verifica

En `dev` y `stg`, todo `AWS::ECS::Cluster` que declare `ClusterSettings` con `containerInsights` tiene el valor `disabled`. Un clúster sin ese setting pasa (el default del recurso es `disabled`). Cualquier otro valor (`enabled`, `enhanced`) o un valor no resoluble falla. En `prod` la regla no corre.

## Por qué

Container Insights crea vistas y **cobra por métrica sin que nadie lo pida**; es lo único que, según la auditoría de costos, genera costo de observabilidad por defecto. Varios proyectos ya lo prohíben o lo restringen cada uno por su cuenta, con tres matices distintos (sin test, prohibido habilitado, o solo en prod y solo si un panel lo lee).

## Cómo corregirlo

`containerInsights: false` (o `ContainerInsights.DISABLED`) fuera de prod. En prod puede estar habilitado.

## De dónde viene

Tres gates locales de proyectos distintos y un cuarto valor sin test, reconciliados aquí en una sola regla.

## Límites conocidos

- La variante más estricta («en prod, solo si un panel lo lee») queda como regla de proyecto: depende de un directorio de paneles que el motor no conoce.
- Un setting de **cuenta** (`containerInsights` por defecto a nivel de cuenta) no aparece en el template y no se ve.
