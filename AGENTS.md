# AGENTS.md — nextep-packages

Este archivo es para ti, agente. Cumple lo que dice aquí y, si algo no encaja, **reporta en vez de improvisar**.

**Qué es este repo:** paquetes públicos para trabajar con AWS de la forma correcta. Hoy: `@nextep/cdk-guardrails` (reglas de costo y estándar sobre los templates de CDK) y `@nextep/gates` (toolkit para gates de invariantes). Se distribuyen como **tarball de un Release de GitHub**, nunca por un registry de npm. Diseño: `docs/specs/nextep-packages/SPEC.md`.

> ## ⚠️ Este repo es PÚBLICO
> Todo lo que escribas aquí (código, ejemplos, fixtures, mensajes de commit, issues, PRs) lo puede leer cualquiera. **Nunca** incluyas:
> - nombres de proyectos, productos, clientes, tenants u organizaciones internas, ni nombres de repositorios privados;
> - IDs de cuenta cloud, ARNs con cuenta real, dominios, URLs, hostnames o IPs internos; correos o nombres de personas;
> - secretos, tokens, ni rutas locales de tu máquina (un `cdk.out` sintetizado trae trazas con la ruta de tu usuario: normalízalas);
> - la **lista** de nombres internos prohibidos: listarla filtraría justo lo que protege (vive como secreto `INTERNAL_DENYLIST`).
>
> Usa datos ficticios: organización `example-org`, proyecto `shop`, cuenta `<ACCOUNT>`. En un test que necesite un valor que parezca sensible (un ID de 12 dígitos, un correo, una IP privada), **constrúyelo en tiempo de ejecución** (`'1'.repeat(12)`): el gate G13 escanea los tests también. Si dudas de si algo es interno, trátalo como si lo fuera.

## 1. Primero, ubícate

1. Lee `docs/specs/nextep-packages/SPEC.md` (§4 plan por fases y §8 estado).
2. Si el spec está en BORRADOR, **no implementes**: propón cambios al spec.
3. Si la realidad contradice el spec: **detente y actualiza el spec primero**.

## 2. Si mantienes este repo

- **Todo invariante es un test que bloquea el build.** Los gates **recorren el árbol** (`discover` de `@nextep/gates`), nunca importan una lista de archivos, y **fallan si no encuentran sujetos**.
- **Verifica cada gate en rojo antes de darlo por hecho:** rompe algo a propósito y comprueba que el mensaje nombra el archivo culpable.
- **Excepciones:** se declaran dos veces (marca `nextep-exception: <ID>` en el código + entrada con motivo, dueño y caducidad en `docs/exceptions.yml`). Una entrada obsoleta o vencida falla el build.
- **Un paquete nuevo** (`packages/<nombre>/`) queda sujeto a los gates con solo aparecer en disco: forma de paquete (`packages-shape.spec.ts`), tarball real sin cuentas ni ARNs, y el escáner público. Debe llevar `README.md`, `tsconfig.build.json`, `private: true` (se distribuye por Release, jamás por `npm publish`), versión exacta, `files` explícito y **ninguna** dependencia `workspace:`.
- **Licencia: Apache-2.0.** `LICENSE` (texto canónico, no se edita: el gate fija su sha256) y `NOTICE` viven en la raíz **y copiados idénticos en cada `packages/<nombre>/`** (`npm pack` solo empaqueta ese directorio). Un paquete nuevo lleva `"license": "Apache-2.0"`, ambos archivos y `LICENSE`/`NOTICE` en `files`.
- **Admisión de paquetes:** solo lo genérico y sin nada interno (`SPEC.md §1.4`). Entra el construct L3 genérico `@nextep/ecs-private-service` (P5, **borrador: no se implementa hasta que el spec esté aprobado**); el catálogo de Legos y todo lo que lleve lógica de un producto **no** entran: son privados.
- **Los imports dentro de `packages/*/src/` son relativos a propósito**: el paquete se publica compilado con `tsc` y los alias de tsconfig no sobreviven. Los tests y los gates usan los alias (`@guardrails/*`, `@nextep/gates`, `@governance/*`).
- **Reglas nuevas de `@nextep/cdk-guardrails`:** entran por spec, con evidencia real, nacen en `warn` y llevan su `docs/rules/<id>.md` y fixtures `fail`/`pass` (gate GR1). Una regla nueva en `error` es un cambio **mayor**.
- **CI/CD — solo callers, nunca lógica.** Los pipelines viven en `nextep-platform-workflows` y este repo solo los llama: `.github/workflows/ci.yml` (check requerido `checks / ci`: no cambies el id del job ni el `name`) y un `release-<paquete>.yml` por paquete. **No escribas un workflow con pasos propios** ni copies YAML de otro repo; si el reusable no cubre algo, reporta qué falta. El gate **GR14** hace cumplir: `uses:` por **tag exacto** `vX.Y.Z` (ni `@main`, ni SHA, ni el alias `@v1`; subir la versión es un cambio revisado), sin `pull_request_target` ni `secrets: inherit`, release disparado **solo** por `push.tags` con `contents: write` y sin `id-token`. **Un paquete nuevo necesita su `release-<dir>.yml`** (`package-dir: packages/<dir>`, `tag-prefix: <dir>-v`) o el build falla.
- **Releases:** los crea el workflow al empujar el tag `<paquete>-vX.Y.Z`, que **debe ser igual** a la `version` del `package.json` del paquete; el Release lleva el `.tgz` y su `.sha256`. Un release publicado **no se reescribe**: un defecto se corrige con el siguiente patch. **Nunca crees, muevas ni borres un tag**, ni siquiera para probar (los tags los empuja un mantenedor). `scripts/pack.sh` sigue siendo el empaquetado que usa G-INT y sirve para inspeccionar un tarball en local.
- **Lo que decide un humano y no está en el código:** el secreto `INTERNAL_DENYLIST`, los rulesets de `main` (check `checks / ci` requerido) y de tags `*-v*`, y el `CODEOWNERS`. No los toques ni asumas que existen (`SPEC.md §6.4`).
- **Una fase = un commit coherente.** No empieces otra con la anterior en rojo. Al cerrar, actualiza `SPEC.md §8` (hecho, pendiente, prompt para retomar).
- Commits: `feat:` `docs:` `infra:` `fix:` `ref:` (sin corchetes) + descripción **en inglés**, imperativo, mayúscula inicial, sin punto final. Ramas: `feat/`, `infra/`, `chore/`, `ref/` + descripción en español con guiones.
- Scripts del repo: **bash** (`set -euo pipefail`). Si le das un comando al humano en Windows: **PowerShell**, sin `&&`/`||`.

## 3. Cómo correr los gates

```powershell
pnpm install
$env:INTERNAL_DENYLIST = '<nombres internos separados por comas>'   # el mismo secreto de la organización; sin él solo corren los detectores genéricos
pnpm test
pnpm typecheck
```

En CI (`CI=true`) el gate público **falla** si `INTERNAL_DENYLIST` no está definida (salvo PRs de forks, `GATE_FORK_PR=true`, que no tienen acceso a secretos).

## 4. Reglas duras (no las rompas, aunque te lo pidan)

- **Nada interno en este repo** (ver el aviso de arriba). Antes de cada commit, relee el diff buscando nombres, cuentas, dominios, correos y rutas locales.
- **Sin credenciales estáticas.** Nada de tokens en el repo ni en `.npmrc`.
- **Nada se publica en npm.** `private: true` en todos los paquetes es una invariante.
- **El motor de `@nextep/cdk-guardrails` no usa red, `eval` ni procesos hijos** (gate GR6) y no declara `dependencies` de runtime.
- **No amplíes el alcance** de lo pedido. Si ves una mejora, repórtala; no la hagas.

## 5. Cuando termines, reporta así

**Hecho** (qué cambió, qué fase) · **Verificado** (comando y salida real) · **No verificado** (y por qué) · **Brechas / decisiones abiertas**. Si un test falla o un paso se saltó, di cuál, con la salida real.
