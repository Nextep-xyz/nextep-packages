# Spec: `nextep-packages` — paquetes públicos de revisión estándar, distribuidos por Release

- **Estado:** **P0 ejecutada el 2026-11-18** y **P1, lado consumidor, ejecutada el 2026-11-20** (rama `chore/instalar-cicd-de-la-plataforma`: callers + gates GR14 y G-INT; el PR y el primer run en GitHub: ver §8). El alcance lo fijó el responsable del repo por instrucción directa («el primer lote son los paquetes, crea el repo local, hazlo de forma autónoma y ponle los guards de público de la plataforma»); **este spec se redactó y ejecutó en la misma sesión: requiere su revisión a posteriori** (§7). Siguiente: P2 (migrar a los consumidores), que necesita un Release real de cada paquete.
- **Origen:** el spec privado de `cdk-guardrails` (repo de diseño de Nextep) construyó el paquete y planeó distribuirlo por un registry privado. Se descartó: un registry privado exige credencial en cada máquina de desarrollo (el token de CodeArtifact dura como máximo 12 h) y no existe forma de que la pertenencia a una organización de GitHub sea una credencial local. Como los paquetes solo codifican formas correctas de trabajar con AWS y no contienen nada sensible, la fricción cero se consigue haciéndolos **públicos**.
- **Categoría:** plataforma / DevSecOps. **Idioma de docs y mensajes:** español (ver Q3).

---

## 1. Problema y alcance

### 1.1 Problema

Las reglas de costo y estándar se reimplementan por proyecto y los gates de invariantes se reescriben cada vez con los mismos tres errores: listan archivos en vez de descubrirlos, pasan en verde cuando no encuentran nada y dejan las excepciones en prosa. Falta un lugar único, versionado e instalable sin fricción donde vivan.

### 1.2 Entra

- Un monorepo **público** `nextep-packages` con dos paquetes:
  - `@nextep/cdk-guardrails`: motor puro + plugin de policy validation de CDK + helper de Jest + CLI, con 8 reglas de costo y estándar (extraído del repo privado, **sin historial** y **limpiado**).
  - `@nextep/gates`: `discover` (por disco, falla sin sujetos), higiene de excepciones declaradas dos veces con caducidad, y `scanPublic` (los detectores del gate G13 de `nextep-platform-workflows`).
- Los **guards de repo público** (los mismos de la plataforma) y los guards de forma de paquete, todos como tests que bloquean el build.
- La **distribución**: tarball `npm pack` adjunto a un Release de GitHub (`<paquete>-vX.Y.Z`) con su `.sha256`, instalado por URL con versión exacta.

### 1.3 Queda fuera (explícito)

- El **catálogo de módulos CDK** del repo privado de diseño: es diseño propio, `experimental` y sin adoptante; se evalúan después (Q4).
- Publicar en npmjs.com o GitHub Packages. **Ningún paquete se publica en un registry**: `private: true` es una invariante (guard G-PKG).
- Escribir pipelines. Los workflows viven en `nextep-platform-workflows`; aquí solo se **piden** (§6).
- Reglas nuevas de `cdk-guardrails` (familias de seguridad, red, identidad, alarmas): entran por spec con evidencia real, en `warn` (P3).
- Migrar a los consumidores (P2): lo ejecuta cada repo consumidor, no este.

### 1.4 Regla de admisión (qué puede vivir en este repo)

El nombre `nextep-packages` es genérico a propósito (I1); lo que acota el alcance es esta regla, que decide **un humano** (un `CODEOWNERS` sobre `packages/`, **aún por crear junto con el ruleset de Q5**, porque «genérico» no es mecanizable). Un paquete entra solo si cumple **las tres**:

1. **Es genérico:** sirve a cualquiera que trabaje con AWS (reglas, gates, y a futuro constructs genéricos como un apagado programado). No es el producto ni una ventaja competitiva.
2. **No contiene nada interno** ni de un cliente: lo hace cumplir el gate G13, que corre sobre el paquete en cuanto aparece en disco.
3. **Su difusión es irreversible y aceptable** (I5): se publica sabiendo que no se retira.

**Fuera, por decisión (2026-11-19):** el construct L3 del contable white-label (`@nextep/accounting-cdk`) **no es público** y se queda en el repo de diseño privado, distribuido por CodeArtifact: codifica cómo corre el motor (propiedad intelectual de un producto que se vende por su auditabilidad) y el registry da la evidencia de qué cuenta descargó qué versión (spec `white-label-l3-construct` §3.5). Tampoco entra el catálogo de Legos (Q4). Lo privado va a un registry privado (R4).

---

## 2. Diseño

### 2.1 Distribución

```
repo público  ──tag cdk-guardrails-v0.1.0──▶  Release  ──▶  nextep-cdk-guardrails-0.1.0.tgz (+ .sha256)
consumidor:  "@nextep/cdk-guardrails": "https://github.com/<org>/nextep-packages/releases/download/cdk-guardrails-v0.1.0/nextep-cdk-guardrails-0.1.0.tgz"
```

- **Sin registry, sin autenticación, sin login**: local y CI hacen `pnpm install` normal. El lockfile fija el `integrity` sha512 del tarball: un asset alterado falla el install (**verificado**, §8).
- **Versión exacta siempre.** Sin rangos semver: es lo que el diseño ya exigía (una regla nueva en `error` es un cambio mayor).
- El nombre `@nextep/*` no es un scope de registry (no hay registry): es solo el nombre del paquete.
- **Tag de release:** `<paquete>-vX.Y.Z`; el asset: `nextep-<paquete>-X.Y.Z.tgz`. Ambos quedan grabados en el lockfile de cada consumidor (I2).

### 2.2 Estructura

```
packages/cdk-guardrails/   @nextep/cdk-guardrails   (src, bin, docs/rules, fixtures, test)
packages/gates/            @nextep/gates            (src, test)
governance/gates/          gates del REPO (descubren por disco): públicos, forma de paquete, reglas, excepciones
governance/lib/            lógica pura de esos gates
scripts/pack.sh            arma el tarball + .sha256 de un paquete (bash)
docs/exceptions.yml        excepciones declaradas (hoy ninguna)
```

Los gates del repo se escriben **con `@nextep/gates`**: el repo consume su propio método (dogfooding), así que el paquete se prueba bajo la misma suite que bloquea el build.

### 2.3 Decisiones tomadas (con motivo)

| Decisión | Motivo | Alternativa descartada |
|---|---|---|
| Repo público aparte, no `nextep-platform-workflows` | Ciclos de release distintos (tags `vX.Y.Z` de la plataforma vs tags por paquete), toolchains distintos, y renombrar la plataforma rompería los `uses:` de todos | Un directorio `packages/` dentro de la plataforma |
| Nombre genérico `nextep-packages` | La URL del release queda en cada lockfile (I1): un nombre atado a un paquete obliga a otro repo con el segundo | `nextep-cdk-guardrails` |
| Sin historial de git | El historial del paquete trae los nombres internos y rutas locales que se limpiaron | `git subtree split` |
| Denylist de nombres internos **fuera** del repo (`INTERNAL_DENYLIST`, secreto de la organización) | Listarla en el repo filtraría justo lo que protege; es el diseño del gate G13 de la plataforma | Una lista versionada |
| `private: true` permanente | Hace fallar un `npm publish` accidental; `npm pack` y la instalación por URL siguen funcionando | Quitarlo (era el plan del registry privado) |
| Imports relativos dentro de `packages/*/src/` | El paquete se distribuye compilado con `tsc`; los alias de tsconfig no sobreviven | Alias absolutos (rotos en el tarball) |

---

## 3. Guards y su test

> Un guard sin test es prosa. Todos descubren sujetos **por disco** y fallan si no encuentran ninguno. Verificados en rojo (§8).

| # | Guard | Test | Dónde |
|---|---|---|---|
| **G13** | Ningún archivo del repo lleva nombres internos (denylist), ID de cuenta de 12 dígitos, ARN con cuenta, correo fuera de `@example.*`, IP privada ni host fuera de la allowlist. En CI **falla si falta `INTERNAL_DENYLIST`** (salvo forks). Sin valores en la salida | `governance/gates/public-names.spec.ts` + `packages/gates/test/public-scan.spec.ts` | repo |
| **G-PKG** | Todo `packages/*` (descubierto por disco, mínimo 2): nombre `@nextep/<dir>`, versión exacta, `private: true`, `license: "Apache-2.0"`, `LICENSE` (texto canónico, sha256 fijado) y `NOTICE` en la raíz y copia idéntica en cada paquete (`npm pack` solo empaqueta el directorio del paquete), `description`, `engines.node`, `main`/`types`, `files` explícito, scripts `build`/`prepack`, `tsconfig.build.json`, `README.md`, sin `publishConfig`, sin dependencias `workspace:`/`file:`/flotantes, nombres únicos | `governance/gates/packages-shape.spec.ts` | repo |
| **GR8** | El tarball **real** de cada paquete (`npm pack --dry-run` sobre una copia compilada) lleva `dist/`, `README.md`, `LICENSE`, `NOTICE` y los `bin`, **no** lleva `src/`, `test/`, `fixtures/` ni `node_modules/`, y su contenido no tiene cuentas, ARNs, endpoints de AWS ni `publishConfig` | `packages-shape.spec.ts` | repo |
| **GR1** | Toda regla de `cdk-guardrails/src/rules` tiene id único, severidad, doc `docs/rules/<id>.md` y fixtures `fail` y `pass`; falla si descubre menos de 8 reglas o si una regla en disco no está registrada | `governance/gates/guardrails-rules.spec.ts` | repo |
| **GR2/GR3** | Cada regla en rojo nombra stack y recurso; NX-POWER-001 no admite excepción, ni siquiera marcada | `packages/cdk-guardrails/test/fixtures.spec.ts` | paquete |
| **GR4/GR5** | No existe forma de desactivar una regla (ni por `Validations.acknowledge`); las excepciones (marca sin entrada, entrada sin marca, vencida, sobre regla que no la admite) fallan nombrando el culpable | `gr4.spec.ts`, `exceptions.spec.ts` | paquete |
| **GR6/GR7** | El motor no usa red, `eval`, `Function` ni procesos hijos; cero `dependencies` de runtime; `aws-cdk-lib` y `constructs` solo como `peerDependencies` | `governance/gates/guardrails-package.spec.ts` | repo |
| **GR9** | La CLI evalúa el `cdk.out` real: un proyecto sin plugin ni helper, con un `Dashboard`, falla | `packages/cdk-guardrails/test/cli.spec.ts` | paquete |
| **G-EXC** | Las excepciones del repo se declaran dos veces (marca `nextep-exception: ID` + entrada con motivo, dueño y caducidad); falla con marca huérfana, entrada obsoleta o vencida | `governance/gates/exceptions-hygiene.spec.ts` | repo |
| **GR14** | Todo `.github/workflows/*.yml` (descubierto por disco, mínimo 3) es un **caller** de la plataforma: `uses:` por tag **exacto** `vX.Y.Z` (no `@main`, ramas, SHAs ni el alias `@v1`); sin `pull_request_target` ni `secrets: inherit`; el caller de CI pide exactamente `contents: read`; un caller de release dispara **solo** por `push.tags` (el patrón cubre su `tag-prefix`), pide `contents: write` y nada más (jamás `id-token`). Completitud: cada `packages/*` tiene **exactamente un** caller de release con `tag-prefix: <dir>-v` y `package-dir: packages/<dir>`; un paquete nuevo sin caller falla el build. Los mensajes llevan `<archivo>:<línea>` | `governance/gates/workflow-callers.spec.ts` | repo |
| **G-INT** | Un tarball alterado falla el install de un consumidor: `scripts/pack.sh` real → instalar por URL (servidor local que imita el 302 de los assets, registry muerto) → el lockfile graba el `integrity` sha512 de esos bytes y la URL → asset alterado + store limpio → `ERR_PNPM_TARBALL_INTEGRITY` → control con los bytes originales. Falla (no se salta) si no hay pnpm o bash. **Límite:** el sujeto es todo paquete **sin `dependencies` de runtime** (hoy `@nextep/cdk-guardrails`; `@nextep/gates` las tiene y obligaría a hablar con un registry), mínimo 1 | `governance/gates/tarball-integrity.spec.ts` | repo |

---

## 4. Plan por fases

**Reglas de ejecución:** una fase = un commit (o PR) coherente; no se arranca la siguiente con la anterior en rojo; si la realidad contradice el spec, **se actualiza el spec primero**; al cerrar cada fase se actualiza §8.

### P0 — Repo local con los dos paquetes y los guards públicos *(HECHA 2026-11-18)*
- **Hecho:** estructura, `@nextep/gates`, `@nextep/cdk-guardrails` limpiado y sin historial, G13, G-PKG, GR1–GR9, G-EXC, `scripts/pack.sh`, `AGENTS.md`, este spec. **Sin push.**
- **Aceptación (cumplida):** `pnpm test` verde con `INTERNAL_DENYLIST` activa; `pnpm typecheck` limpio; cada gate nuevo verificado en rojo.

### P1 — Release por reusable de la plataforma *(lado consumidor HECHO 2026-11-20; la plataforma, ya liberada en `v1.5.1`)*
- **Objetivo:** que un tag `<paquete>-vX.Y.Z` produzca el Release con el `.tgz` y el `.sha256`, y que el repo tenga CI que bloquee el merge. **Dependencias:** P0 subida a GitHub como repo público; secreto de organización `INTERNAL_DENYLIST`; Q1.
- **Toca (en `nextep-platform-workflows`, sesión aparte, repo público: nada interno):** un reusable de CI genérico sin AWS (instalar, `pnpm test`, `pnpm typecheck`, pasando `INTERNAL_DENYLIST` y `GATE_FORK_PR`) y un reusable de release (§6). **Toca (aquí):** los callers de pocas líneas, por tag, sin ARN ni secreto literal. **No toca:** los dos workflows AWS existentes.
- **Pruebas:** en la plataforma, bats con `gh`/`npm` falsos (tag ⇔ `version`, asset con el nombre esperado, no se reescribe un Release existente) y los gates de permisos mínimos y acciones por SHA. Aquí: gate GR14 (todo caller usa un tag de la plataforma, no `@main`) y **G-INT como test**.
- **Estado real:** los dos reusables existen en la plataforma y están en su tag `v1.5.1`: `lego-node-ci` (job `ci`) y `lego-package-release` (jobs `gate` y `release`). Aquí: `.github/workflows/ci.yml`, `release-gates.yml` y `release-cdk-guardrails.yml` (fijados a `@v1.5.1`), GR14 y G-INT como test. **Pendiente de un humano:** el secreto `INTERNAL_DENYLIST` y los rulesets (§6.4); **pendiente de un Release real:** lo que §8 lista como no verificado.
- **Aceptación:** el CI es *required status check*; un tag de prueba produce un Release descargable desde una URL pública y `pnpm install` del tarball falla si se altera. **Rollback:** no liberar el tag del reusable; un Release publicado no se reescribe (se corrige con el siguiente patch).

### P2 — Migrar a los consumidores
- **Objetivo:** el repo privado de diseño y los proyectos consumen el paquete por URL y se borran las copias. **Dependencias:** P1 con un Release real de `cdk-guardrails-v0.1.0` y de `gates`.
- **Toca (cada repo consumidor, en su propia sesión):** la dependencia pasa de workspace/tarball local a la URL exacta; se retira `packages/cdk-guardrails` del repo privado; el gate de versión fija (GR11) acepta la URL con versión exacta y rechaza rangos. **No toca:** este repo.
- **Aceptación:** la suite de cada consumidor verde con la dependencia por URL; `pnpm install --frozen-lockfile` en un clon limpio, en Windows y Linux.

### P3 — Reglas v2 de `@nextep/cdk-guardrails` *(solo con spec y evidencia)*
- Familias candidatas (cada regla necesita un caso real que la respalde y nace en `warn`): arquitectura de red de tres capas, parámetros inmutables de Cognito, base de datos sin acceso público, IAM sin comodines, imagen sin tag `latest`, alarmas con acción. Una regla nueva en `error` es un cambio mayor.

### P4 — Crecer `@nextep/gates`
- Extraer del repo privado lo que siga acoplado y sea genérico (helper para verificar un gate en rojo, lógica de invariantes de spec). Cada pieza con su test y sin acoplamiento al repo de origen.

---

## 5. Riesgos y puntos irreversibles

### 5.1 Irreversibles (revisar una vez y bien)

| # | Qué | Por qué no se corrige después |
|---|---|---|
| **I1** | **Organización y nombre del repo** (`<org>/nextep-packages`) | Están en la URL del tarball que cada consumidor graba en su lockfile. GitHub redirige un rename de repo, pero **no está verificado** que redirija las descargas de assets |
| **I2** | **Patrón de tag y de asset** (`<paquete>-vX.Y.Z`, `nextep-<paquete>-X.Y.Z.tgz`) | También quedan en los lockfiles y en los rulesets de tags |
| **I3** | **Nombres de paquete** (`@nextep/cdk-guardrails`, `@nextep/gates`) | Aparecen en `package.json` y lockfiles de cada consumidor |
| **I4** | **IDs de regla `NX-*`** | Viven en las marcas de excepción de cada proyecto; renombrarlos invalida excepciones vigentes |
| **I5** | **Todo lo que se publique** | Un repo público se clona y se indexa: borrar un archivo después **no** lo retira del historial ya copiado. De ahí que P0 parta sin historial y con el gate público antes del primer push |

### 5.2 Riesgos corregibles

| # | Riesgo | Mitigación |
|---|---|---|
| R1 | Una fuga que el gate no detecta (un nombre interno que no está en la denylist) | La denylist vive en un secreto y se mantiene; los detectores genéricos (cuentas, ARNs, correos, IPs, hosts) no dependen de ella; revisión humana del primer push |
| R2 | CI sin reusable: hasta P1 los gates no bloquean ningún merge | Nada se sube hasta tener el CI, o se acepta una excepción **con fecha** (§6) |
| R3 | Un asset de Release se reemplaza | El hash del lockfile lo detecta (verificado); GitHub permite subir un asset con el mismo nombre: la regla «un Release publicado no se reescribe» la hace cumplir el reusable (P1) |
| R4 | El repo se vuelve un cajón de paquetes no públicos | El gate público recorre `packages/*` por disco; lo privado va a un registry privado |
| R5 | Renovate no seguirá bien una dependencia por URL | **No verificado.** Si no la sigue, la actualización es un PR manual; la versión exacta es el requisito, no la automatización |

---

## 6. Brechas de plataforma (lo que había que **pedir**, no construir aquí)

`AGENTS.md`: los pipelines no se escriben en un repo de proyecto ni se copia YAML de otro repo. Estado:

1. **CERRADA — reusable de CI genérico sin AWS:** `lego-node-ci` (plataforma `v1.5.1`, runbook §9.1). Pasa `INTERNAL_DENYLIST` por nombre y deriva `GATE_FORK_PR` del evento.
2. **CERRADA — reusable de release de paquete por GitHub Release (no AWS):** `lego-package-release` (plataforma `v1.5.1`, runbook §9.2): valida tag ⇔ `version` y prefijo, corre tests, un solo `npm pack`, revisa **ese** tarball, publica `.tgz` + `.sha256` con el `GITHUB_TOKEN` del run (`contents: write` solo en el job `release`), no reescribe un Release existente y vuelve a descargar los assets para comparar el digest. El nombre `lego-aws-package-publish` (CodeArtifact) no se tocó (Q1).
3. **CADUCADO — procedimiento manual provisional** (`gh release create` a mano). Ya no es el camino: el Release lo crea el workflow al empujar el tag (README, «Cómo se libera»). No lo uses; si el reusable falla, se arregla en la plataforma y se libera de nuevo, no se publica a mano.
4. **Lo que NO está en código y decide un humano (la plataforma no puede):** el secreto de organización `INTERNAL_DENYLIST`; un **ruleset de tags** (`*-v*`: solo mantenedores los crean, nadie mueve ni borra uno: Q5); un **ruleset de `main`** que exija el PR y el check `checks / ci` (sin él, el CI corre y no bloquea nada); y el `CODEOWNERS` de `packages/` (§1.4).

---

## 7. Preguntas abiertas

| # | Pregunta | Bloquea | Propuesta |
|---|---|---|---|
| **Q1** | **RESUELTA (2026-11-20): dos reusables sin «aws» en el nombre, `lego-node-ci` y `lego-package-release`.** ¿Se reabre el nombre del reusable de publicación (hoy atado a CodeArtifact y a «aws») y se parte en dos: CI genérico y release por Release? | — | Hecho en la plataforma (`v1.5.1`); `lego-aws-package-publish` queda para CodeArtifact |
| **Q2** | **RESUELTA (Isaac, 2026-11-19): Apache-2.0.** ¿Licencia? Criterio: las reglas son públicas porque no comprometen nada, de libre uso y reimaginación (también comercial), sin responsabilidad para Nextep por bugs o retrasos de quien las use | — | Apache-2.0 sobre MIT: mismo descargo de garantía y de responsabilidad (cláusulas 7 y 8), más concesión de patentes y **sin derecho sobre el nombre ni las marcas** (cláusula 6), que protege `@nextep/*`. `LICENSE` canónico (sha256 fijado por el gate) + `NOTICE`, copiados a cada paquete. **Titular del copyright: «Nextep Innovation» (por confirmar el nombre legal exacto)** |
| **Q3** | ¿Idioma de docs y mensajes de las reglas? Hoy español | Adopción externa | Español (consumidores internos); un i18n solo si aparece un consumidor externo |
| **Q4** | ¿Se publica algún día el catálogo de módulos CDK del repo privado? | Nada | No ahora: son diseño propio, `experimental` y sin adoptante |
| **Q5** | ¿Quién puede crear tags `*-v*`? | P1 | Solo mantenedores, con un ruleset de tags (paso manual en GitHub) |
| **Q6** | **Revisión a posteriori de este spec** (se redactó y ejecutó en la misma sesión) | Subir el repo | Revisar §2.3, §3 y §5 antes del primer push |

---

## 8. Estado y retoma

### P1, lado consumidor (2026-11-20, rama `chore/instalar-cicd-de-la-plataforma`)

- **Hecho:**
  - `.github/workflows/ci.yml` (job `checks` → check requerido **`checks / ci`**; `on: pull_request` y `push` a `main`; `contents: read`; `INTERNAL_DENYLIST` por nombre), `release-gates.yml` y `release-cdk-guardrails.yml` (solo `push.tags` `gates-v*` / `cdk-guardrails-v*`; `contents: write` y nada más). Los tres llaman a la plataforma por **tag exacto** `@v1.5.1`, no por el alias `@v1`: este repo distribuye código y un cambio de la plataforma no debe alterar su release sin pasar por revisión.
  - GR14 (`workflow-callers.spec.ts`) y G-INT como test (`tarball-integrity.spec.ts`), §3.
- **Verificado en local (comando y salida real):**
  - `pnpm test` → `Test Suites: 18 passed, 18 total`, `Tests: 328 passed, 328 total`; `pnpm typecheck` limpio. **También en Linux** (WSL, copia nativa sin `node_modules` de Windows, `pnpm install --frozen-lockfile`): las mismas 18 suites / 328 tests, G-INT incluido.
  - `actionlint 1.7.12` sobre los tres workflows: `Found 0 errors in 3 files`; `shellcheck 0.11.0` sobre `scripts/pack.sh`: limpio. (Binarios bajados de sus releases oficiales y comprobados contra el digest sha256 publicado.)
  - **GR14 en rojo sobre los archivos reales**, nombrando archivo y línea: `ci.yml` con `@main` → `.github/workflows/ci.yml:14: "…lego-node-ci.yml@main" no esta fijado por un tag EXACTO vX.Y.Z`; `secrets: inherit` → `ci.yml:18: secrets: inherit esta prohibido`; un `packages/zzdemo` sin caller → `packages/zzdemo: sin caller de release en .github/workflows/`; `workflow_dispatch` + `id-token` en `release-gates.yml` → `:15: … pide id-token` y `:10: … dispara por workflow_dispatch`.
  - **G-INT en rojo:** sin pnpm en el `PATH` → falla (`tool: "pnpm"`), no se salta; con una «alteración» que no cambia ningún byte → `Expected: not 0` (el install no falló).
  - **El gate G13 cazó un defecto del propio test nuevo** (URLs de loopback escritas como literal → `URL host outside the public allowlist`); ahora se arman en tiempo de ejecución.
- **Primer run real en GitHub (PR #1, run `44780267665`, `pull_request`, runner Linux):** `checks / ci` en verde en 42 s; `Test Suites: 18 passed, 18 total`, `Tests: 328 passed, 328 total` (G-INT incluido, en Linux) y typecheck limpio. `gh pr checks 1` lista el check como `checks / ci`: el nombre que debe exigir el ruleset. Del runbook de la plataforma §9.5 **quedó verificado**: (1) el `env:` de un paso que usa un composite **sí** llega a los pasos de dentro: el paso de test recibió `INTERNAL_DENYLIST: ***` (enmascarado, no vacío) y `GATE_FORK_PR: false`, y `public-names` pasó (en CI exige la denylist); además, el pin por tag exacto `@v1.5.1` resuelve, `packageManager` hizo que `pnpm/action-setup` cambiara de la v11 del runner a la `10.34.4`, y no hubo diferencias de rutas, modos ni saltos de línea entre Windows y Linux.
- **Sigue sin verificar** (solo con un Release real, que esta fase tiene **prohibido** crear): `actions/upload-artifact` y `download-artifact` con un artefacto-directorio y el layout del download; el texto `release not found` de `gh release view` y `gh release create --verify-tag` con `GITHUB_TOKEN`; que `contents: write` baste para `gh release view/create/download`; el re-download y la comparación del digest. Tampoco se ejercitó: un caller con `INTERNAL_DENYLIST` vacío (aquí el secreto existe a nivel de organización) ni un PR de un fork; el trigger `push` a `main` (corre al mergear); ni los dos callers de release (solo disparan por tag).
- **Brecha en la plataforma:** el título de su runbook §9 sigue diciendo «not released yet» aunque `v1.5.1` ya contiene los dos reusables; se corrige allá, en otro PR.
- **Prompt de retoma (P2, un repo consumidor por sesión):** *«Repo consumidor. Lee `nextep-packages/docs/specs/nextep-packages/SPEC.md` §2.1, §4 P2 y §8. Precondición: existen los Releases `gates-v0.1.0` y `cdk-guardrails-v0.1.0` (los crea un mantenedor empujando el tag; no los crees tú). Cambia la dependencia a la URL exacta del Release (`https://github.com/<org>/nextep-packages/releases/download/<paquete>-vX.Y.Z/nextep-<paquete>-X.Y.Z.tgz`), sin rangos; retira la copia local del paquete; el gate de versión fija acepta la URL con versión exacta y rechaza rangos. Aceptación: suite verde y `pnpm install --frozen-lockfile` en un clon limpio, en Windows y Linux. No toques `nextep-packages`. Reporta Hecho / Verificado / No verificado / Brechas.»*

### P0 (2026-11-18)

- **Hecho (P0, 2026-11-18):** ver §4. 16 suites / 283 tests verdes con una denylist de 26 nombres activa; `pnpm typecheck` limpio.
- **Verificado (comando y salida real):**
  - `pnpm test` → `Test Suites: 16 passed, 16 total`, `Tests: 283 passed, 283 total` (con `INTERNAL_DENYLIST` definida).
  - **Gates en rojo**, cada uno nombrando al culpable: G13 con un archivo que mezcla un nombre interno, un ID de 12 dígitos, un correo, una IP privada y un host ajeno → `docs/leak.md:1: 12-digit cloud account id` / `:1: internal name from INTERNAL_DENYLIST` / `:2: email address` / `:2: private IP address` / `:3: URL host outside the public allowlist`; G-PKG con un paquete **nuevo** descubierto por disco → `packages/zzdemo/package.json: debe declarar "private": true…` y `packages/zzdemo/README.md: falta`; GR1 sin `docs/rules/NX-COST-002.md` → `NX-COST-002: falta docs/rules/NX-COST-002.md`; G-EXC con una marca huérfana → `packages/gates/src/index.ts: marca nextep-exception "EXC-HUERFANA" sin entrada en docs/exceptions.yml`.
  - **El gate público cazó fugas reales de la copia:** trazas con la ruta local del usuario de Windows dentro de `fixtures/dashboard/cdk.out/*.metadata.json` (normalizadas) y cuentas/hosts literales en los tests (ahora se arman en tiempo de ejecución).
  - **Spike de instalación por URL** (servidor local que imita el 302 de los assets de GitHub): `pnpm install` desde `http://localhost/download/<archivo>.tgz` sigue la redirección, escribe `resolution: {integrity: sha512-…, tarball: <url>}` en el lockfile, el bin `nextep-guardrails --list-rules` corre, y `pnpm install --frozen-lockfile` en un clon limpio instala. Con el tarball **alterado** y un store nuevo: `WARN GET … error (ERR_PNPM_TARBALL_INTEGRITY)`.
- **No verificado:** (a) la descarga real desde `github.com` y su redirección a `objects.githubusercontent.com` (solo se imitó en local); (b) ~~Linux~~ **verificado en P1** (suite completa en WSL, ver arriba); (c) npm y yarn como consumidores (solo pnpm); (d) Renovate sobre URLs de tarball; (e) ~~el CI~~ **existe desde P1** (ver arriba); (f) que `.tgz` en Releases no esté limitado por tamaño o por cuota (los dos tarballs pesan 29 kB y 7 kB).
- **Pendiente (tras P0):** P2, P3, P4; Q2–Q6 (Q1 resuelta en P1).
