# Spec: `nextep-packages` — paquetes públicos de revisión estándar, distribuidos por Release

- **Estado:** **P0 ejecutada el 2026-11-18** (repo local creado, sin push). El alcance lo fijó el responsable del repo por instrucción directa («el primer lote son los paquetes, crea el repo local, hazlo de forma autónoma y ponle los guards de público de la plataforma»); **este spec se redactó y ejecutó en la misma sesión: requiere su revisión a posteriori** (§7). Siguiente: P1 (reusable de release en la plataforma) y P2 (migrar a los consumidores).
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
| **G-PKG** | Todo `packages/*` (descubierto por disco, mínimo 2): nombre `@nextep/<dir>`, versión exacta, `private: true`, `license`, `description`, `engines.node`, `main`/`types`, `files` explícito, scripts `build`/`prepack`, `tsconfig.build.json`, `README.md`, sin `publishConfig`, sin dependencias `workspace:`/`file:`/flotantes, nombres únicos | `governance/gates/packages-shape.spec.ts` | repo |
| **GR8** | El tarball **real** de cada paquete (`npm pack --dry-run` sobre una copia compilada) lleva `dist/`, `README.md` y los `bin`, **no** lleva `src/`, `test/`, `fixtures/` ni `node_modules/`, y su contenido no tiene cuentas, ARNs, endpoints de AWS ni `publishConfig` | `packages-shape.spec.ts` | repo |
| **GR1** | Toda regla de `cdk-guardrails/src/rules` tiene id único, severidad, doc `docs/rules/<id>.md` y fixtures `fail` y `pass`; falla si descubre menos de 8 reglas o si una regla en disco no está registrada | `governance/gates/guardrails-rules.spec.ts` | repo |
| **GR2/GR3** | Cada regla en rojo nombra stack y recurso; NX-POWER-001 no admite excepción, ni siquiera marcada | `packages/cdk-guardrails/test/fixtures.spec.ts` | paquete |
| **GR4/GR5** | No existe forma de desactivar una regla (ni por `Validations.acknowledge`); las excepciones (marca sin entrada, entrada sin marca, vencida, sobre regla que no la admite) fallan nombrando el culpable | `gr4.spec.ts`, `exceptions.spec.ts` | paquete |
| **GR6/GR7** | El motor no usa red, `eval`, `Function` ni procesos hijos; cero `dependencies` de runtime; `aws-cdk-lib` y `constructs` solo como `peerDependencies` | `governance/gates/guardrails-package.spec.ts` | repo |
| **GR9** | La CLI evalúa el `cdk.out` real: un proyecto sin plugin ni helper, con un `Dashboard`, falla | `packages/cdk-guardrails/test/cli.spec.ts` | paquete |
| **G-EXC** | Las excepciones del repo se declaran dos veces (marca `nextep-exception: ID` + entrada con motivo, dueño y caducidad); falla con marca huérfana, entrada obsoleta o vencida | `governance/gates/exceptions-hygiene.spec.ts` | repo |
| **G-INT** | Un tarball alterado falla el install de un consumidor | Spike §8 (manual). **Pendiente convertirlo en test** (P1) | — |

---

## 4. Plan por fases

**Reglas de ejecución:** una fase = un commit (o PR) coherente; no se arranca la siguiente con la anterior en rojo; si la realidad contradice el spec, **se actualiza el spec primero**; al cerrar cada fase se actualiza §8.

### P0 — Repo local con los dos paquetes y los guards públicos *(HECHA 2026-11-18)*
- **Hecho:** estructura, `@nextep/gates`, `@nextep/cdk-guardrails` limpiado y sin historial, G13, G-PKG, GR1–GR9, G-EXC, `scripts/pack.sh`, `AGENTS.md`, este spec. **Sin push.**
- **Aceptación (cumplida):** `pnpm test` verde con `INTERNAL_DENYLIST` activa; `pnpm typecheck` limpio; cada gate nuevo verificado en rojo.

### P1 — Release por reusable de la plataforma
- **Objetivo:** que un tag `<paquete>-vX.Y.Z` produzca el Release con el `.tgz` y el `.sha256`, y que el repo tenga CI que bloquee el merge. **Dependencias:** P0 subida a GitHub como repo público; secreto de organización `INTERNAL_DENYLIST`; Q1.
- **Toca (en `nextep-platform-workflows`, sesión aparte, repo público: nada interno):** un reusable de CI genérico sin AWS (instalar, `pnpm test`, `pnpm typecheck`, pasando `INTERNAL_DENYLIST` y `GATE_FORK_PR`) y un reusable de release (§6). **Toca (aquí):** los callers de pocas líneas, por tag, sin ARN ni secreto literal. **No toca:** los dos workflows AWS existentes.
- **Pruebas:** en la plataforma, bats con `gh`/`npm` falsos (tag ⇔ `version`, asset con el nombre esperado, no se reescribe un Release existente) y los gates de permisos mínimos y acciones por SHA. Aquí: gate GR14 (todo caller usa un tag de la plataforma, no `@main`) y **G-INT como test**.
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

## 6. Brechas de plataforma (lo que hay que **pedir**, no construir aquí)

`AGENTS.md`: los pipelines no se escriben en un repo de proyecto ni se copia YAML de otro repo. Falta:

1. **Reusable de CI genérico sin AWS** (instalar, test, typecheck, pasando `INTERNAL_DENYLIST` y `GATE_FORK_PR`). `lego-aws-cicd` está pensado para flujos de despliegue con `compute`.
2. **Reusable de release de paquete por GitHub Release** (no AWS): valida que el tag ⇔ `version` y el prefijo, corre tests, empaqueta, revisa el contenido, adjunta el `.tgz` y el `.sha256` con `GITHUB_TOKEN` (`contents: write`, sin credenciales cloud), no reescribe un Release existente y verifica la descarga. El nombre actual `lego-aws-package-publish` (CodeArtifact) **no encaja**: reabrir Q1 antes de liberar un tag.
3. **Procedimiento manual provisional hasta P1** (lo ejecuta un humano; el primer Release no tiene por qué esperar): en PowerShell, `pnpm install`, `pnpm test`, `bash scripts/pack.sh packages/<paquete>`, `gh release create <paquete>-vX.Y.Z release/<archivos>`. **Caduca al liberar P1.**

---

## 7. Preguntas abiertas

| # | Pregunta | Bloquea | Propuesta |
|---|---|---|---|
| **Q1** | ¿Se reabre el nombre del reusable de publicación (hoy atado a CodeArtifact y a «aws») y se parte en dos: CI genérico y release por Release? | P1 | Sí: dos reusables sin «aws» en el nombre. Es seguro porque el actual no tiene release |
| **Q2** | ¿Licencia? | Subir el repo | Sin licencia explícita (todos los derechos reservados) hasta decidir; `license: UNLICENSED` en los manifiestos |
| **Q3** | ¿Idioma de docs y mensajes de las reglas? Hoy español | Adopción externa | Español (consumidores internos); un i18n solo si aparece un consumidor externo |
| **Q4** | ¿Se publica algún día el catálogo de módulos CDK del repo privado? | Nada | No ahora: son diseño propio, `experimental` y sin adoptante |
| **Q5** | ¿Quién puede crear tags `*-v*`? | P1 | Solo mantenedores, con un ruleset de tags (paso manual en GitHub) |
| **Q6** | **Revisión a posteriori de este spec** (se redactó y ejecutó en la misma sesión) | Subir el repo | Revisar §2.3, §3 y §5 antes del primer push |

---

## 8. Estado y retoma

- **Hecho (P0, 2026-11-18):** ver §4. 16 suites / 283 tests verdes con una denylist de 26 nombres activa; `pnpm typecheck` limpio.
- **Verificado (comando y salida real):**
  - `pnpm test` → `Test Suites: 16 passed, 16 total`, `Tests: 283 passed, 283 total` (con `INTERNAL_DENYLIST` definida).
  - **Gates en rojo**, cada uno nombrando al culpable: G13 con un archivo que mezcla un nombre interno, un ID de 12 dígitos, un correo, una IP privada y un host ajeno → `docs/leak.md:1: 12-digit cloud account id` / `:1: internal name from INTERNAL_DENYLIST` / `:2: email address` / `:2: private IP address` / `:3: URL host outside the public allowlist`; G-PKG con un paquete **nuevo** descubierto por disco → `packages/zzdemo/package.json: debe declarar "private": true…` y `packages/zzdemo/README.md: falta`; GR1 sin `docs/rules/NX-COST-002.md` → `NX-COST-002: falta docs/rules/NX-COST-002.md`; G-EXC con una marca huérfana → `packages/gates/src/index.ts: marca nextep-exception "EXC-HUERFANA" sin entrada en docs/exceptions.yml`.
  - **El gate público cazó fugas reales de la copia:** trazas con la ruta local del usuario de Windows dentro de `fixtures/dashboard/cdk.out/*.metadata.json` (normalizadas) y cuentas/hosts literales en los tests (ahora se arman en tiempo de ejecución).
  - **Spike de instalación por URL** (servidor local que imita el 302 de los assets de GitHub): `pnpm install` desde `http://localhost/download/<archivo>.tgz` sigue la redirección, escribe `resolution: {integrity: sha512-…, tarball: <url>}` en el lockfile, el bin `nextep-guardrails --list-rules` corre, y `pnpm install --frozen-lockfile` en un clon limpio instala. Con el tarball **alterado** y un store nuevo: `WARN GET … error (ERR_PNPM_TARBALL_INTEGRITY)`.
- **No verificado:** (a) la descarga real desde `github.com` y su redirección a `objects.githubusercontent.com` (solo se imitó en local); (b) Linux (solo se corrió en Windows; `scripts/pack.sh` y los gates usan rutas POSIX pero no se ejecutaron allí); (c) npm y yarn como consumidores (solo pnpm); (d) Renovate sobre URLs de tarball; (e) el CI (no existe, §6); (f) que `.tgz` en Releases no esté limitado por tamaño o por cuota (los dos tarballs pesan 29 kB y 7 kB).
- **Pendiente:** P1, P2, P3, P4; Q1–Q6; el primer push lo hace el responsable del repo.
- **Prompt de retoma (P1, en `nextep-platform-workflows`):** *«Repo PÚBLICO: nada interno. Lee `AGENTS.md`, `SPEC.md` §0 y §10 y `docs/runbook.md`. Diseño (de un spec público `nextep-packages/docs/specs/nextep-packages/SPEC.md` §6): crea DOS reusables sin AWS: (1) CI genérico de un repo Node con pnpm (install inmutable, `pnpm test`, `pnpm typecheck`, input opcional para pasar el secreto `INTERNAL_DENYLIST` como `env:` del paso y `GATE_FORK_PR`); (2) release de paquete por GitHub Release (`package-dir`, `tag-prefix`): valida tag ⇔ `version` y prefijo, corre tests, `npm pack`, revisa el contenido (sin `publishConfig`, sin IDs de cuenta de 12 dígitos), adjunta `.tgz` + `.sha256` con `GITHUB_TOKEN` (`contents: write` solo en el job de release), falla si el Release ya existe y verifica la descarga. Contrato primero, bats con `gh` y `npm` falsos, gates por disco en rojo primero, acciones de terceros por SHA, ningún `${{ inputs.* }}` en `run:`. Release aditivo lo crea solo `release.yml`: para al dejar el PR listo. Reporta Hecho / Verificado / No verificado / Brechas.»*
