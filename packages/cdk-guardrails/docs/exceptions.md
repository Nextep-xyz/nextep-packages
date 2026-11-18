# Excepciones: declaradas dos veces, con caducidad

Una regla del catálogo que admite excepción (`nextep-guardrails --list-rules` muestra `excepción=sí`) se silencia **solo** con las dos mitades, y el motor verifica las dos en ambos sentidos.

## Las dos mitades

1. **Marca en el código** (viaja en el template, el motor no lee código fuente):

   ```ts
   import { allowException } from '@nextep/cdk-guardrails';
   allowException(dashboardCfnResource, 'NX-COST-001');   // Metadata: { 'nextep:exception': ['NX-COST-001'] }
   ```

2. **Entrada en `governance/exceptions.yml`** del proyecto (campos `id`, `guard`, `reason`, `owner` y `expires`):

   ```yaml
   version: 1
   exceptions:
     - id: EXC-DASH-001
       guard: NX-COST-001
       reason: "Dashboard exigido por el cliente X en el contrato"
       owner: devops
       expires: "2027-03-31"
   ```

Una entrada cubre todos los recursos del proyecto que lleven la marca de esa regla. Solo se juzgan las entradas con `guard: NX-…`: las de otros guards (`G4`, `tags-finops`…) no son de este motor.

## Qué falla (y cómo se llama)

| Id | Cuándo | Qué nombra |
|---|---|---|
| `NX-EXC-001` | Hay una **marca sin entrada** (o la marca nombra una regla que no existe) | `<stack>/<recurso>` |
| `NX-EXC-002` | Hay una **entrada sin marca** en ningún recurso (obsoleta), o su `guard` no es una regla | el `id` de la entrada |
| `NX-EXC-003` | La entrada **venció** (`expires`; vigente hasta el final de ese día, UTC) | el `id` y la fecha |
| `NX-EXC-004` | La marca o la entrada es sobre una regla que **no admite excepción** (`NX-FIN-001`, `NX-POWER-001`, `NX-POWER-004`) | `<stack>/<recurso>` o el `id` |

Con la entrada vencida o ausente, la violación original **reaparece**: una excepción caducada no deja pasar nada.

## Lo que NO existe

- Una opción `skip`/`disable`/`ignore` en el contexto, la CLI o el plugin: el motor **rechaza** los campos que no conoce.
- `Validations.of(app).acknowledge({ id: 'NextepGuardrails::<regla>' })` de CDK: el plugin **lo detecta y aborta el synth**. La única excepción es la de arriba.
- `cdk deploy --ignore-errors` y `cdk deploy --app cdk.out` se saltan el plugin (verificado); por eso el CI vuelve a evaluar el `cdk.out` real con la CLI, que no confía en el plugin.
