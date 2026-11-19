# @nextep/gates

Toolkit para escribir **gates de invariantes** que no se pueden olvidar.

La idea: una regla de arquitectura que vive en prosa se incumple en silencio. Aquí se vuelve un test que bloquea el build, con tres piezas.

| Pieza | Qué resuelve |
|---|---|
| `discover(globs, { cwd, min })` | Descubre los sujetos **por disco**, nunca por una lista de imports: el caso que importa es el archivo nuevo, escrito por quien no leyó la regla. **Falla si hay menos de `min` sujetos**: un gate que no encuentra nada pasa en verde y no prueba nada. |
| `checkExceptions(entries, marks, today)` | Excepciones **declaradas dos veces**: una marca en el código (`// nextep-exception: ID`) y una entrada con motivo, dueño y caducidad. Falla con marca huérfana, entrada obsoleta o vencida. |
| `scanPublic({ root, denylist })` | Higiene para repos **públicos**: ID de cuenta de 12 dígitos, ARN con cuenta, correo, IP privada, URL fuera de la allowlist y nombres internos de una denylist. Mismos detectores que el gate G13 de `nextep-platform-workflows`. Nunca imprime el valor encontrado. |

```ts
import { discover, scanPublic, parseDenylist, formatFindings } from '@nextep/gates';

// Un gate que descubre por disco y falla sin sujetos:
const rules = discover(['src/rules/*.ts'], { cwd: ROOT, min: 8 });

// Un gate de repo público (la denylist llega por entorno, nunca vive en el repo):
const r = scanPublic({ root: ROOT, denylist: parseDenylist(process.env.INTERNAL_DENYLIST), requireDenylist: process.env.CI === 'true' });
expect(formatFindings(r.findings)).toBe('');
```

## Reglas del método (compártelas con quien escriba un gate)

1. **Verifica el gate en rojo antes de darlo por hecho:** rompe algo a propósito y comprueba que el mensaje nombre el archivo culpable.
2. Las excepciones se declaran **dos veces** y el gate falla si la lista acumula una entrada obsoleta.
3. El gate va en la suite que **bloquea el build**, no en una que nadie corre.
4. La denylist de nombres internos **no se versiona**: listarla en el repo filtraría justo lo que protege.

## Desarrollo

`pnpm test` desde la raíz del repo. Dependencias de runtime: `fast-glob` y `yaml`.

## Licencia

[Apache-2.0](LICENSE): uso, modificación y redistribución libres. Se ofrece «tal cual», sin garantía; Nextep no responde por bugs ni retrasos que cause su uso. Sin derecho sobre el nombre ni las marcas de Nextep. Avisos en [NOTICE](NOTICE).
