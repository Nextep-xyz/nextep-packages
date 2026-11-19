# nextep-packages

Paquetes públicos para trabajar con AWS de la forma correcta: formas de trabajo codificadas como **gates ejecutables**, no como prosa que se incumple en silencio.

| Paquete | Qué es |
|---|---|
| [`@nextep/cdk-guardrails`](packages/cdk-guardrails) | Reglas de costo y estándar sobre los templates de CDK sintetizados, con plugin de policy validation, helper de Jest y CLI. Falla **antes** de desplegar. |
| [`@nextep/gates`](packages/gates) | El método: gates que **descubren sus sujetos por disco** y fallan si no encuentran ninguno, excepciones declaradas dos veces con caducidad y un escáner de higiene para repos públicos. |

## Cómo se consumen

No están en ningún registry de npm. Cada versión es un **Release de GitHub** con su tarball (`<paquete>-vX.Y.Z`) y su `.sha256`. Se instalan por URL, con versión exacta y sin credenciales (ver el README de cada paquete). El lockfile del consumidor fija el hash.

## Qué garantiza este repo (cada punto es un test que bloquea el build)

- **Es público de verdad:** ningún archivo lleva nombres internos, IDs de cuenta, ARNs con cuenta, correos, IPs privadas ni hosts ajenos (`governance/gates/public-names.spec.ts`, mismos detectores que el gate G13 de `nextep-platform-workflows`).
- **Todo paquete cumple la forma** y su **tarball real** no lleva cuentas, ARNs ni `publishConfig` (`governance/gates/packages-shape.spec.ts`). Un paquete nuevo queda sujeto con solo aparecer en `packages/`.
- **Las reglas se descubren por disco**: toda regla de `cdk-guardrails` tiene id único, documentación y fixtures `fail`/`pass` (`governance/gates/guardrails-rules.spec.ts`).
- **Las excepciones se declaran dos veces** y caducan (`governance/gates/exceptions-hygiene.spec.ts`).

## Licencia y uso

[Apache-2.0](LICENSE). Son reglas de trabajo que nos sirven a nosotros y que no comprometen nada, así que son de **libre uso, modificación y redistribución**, incluso con fines comerciales: tómalas, adáptalas o reimagínalas en tus propias versiones.

Se ofrecen **«tal cual», sin garantía de ningún tipo**. Nextep no responde por bugs, retrasos ni daños que su uso cause en tu desarrollo (cláusulas 7 y 8 de la licencia). La licencia **no** concede derecho a usar el nombre ni las marcas de Nextep (cláusula 6). Los avisos de copyright están en [NOTICE](NOTICE).

## Desarrollo

```powershell
pnpm install
pnpm test          # gates + tests de cada paquete
pnpm typecheck
```

Lee `AGENTS.md` antes de contribuir y `docs/specs/nextep-packages/SPEC.md` para el diseño y el estado.
