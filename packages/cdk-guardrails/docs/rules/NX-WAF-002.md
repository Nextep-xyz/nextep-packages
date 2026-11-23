# NX-WAF-002 — La WebACL no está solo en count y tiene logging

| | |
|---|---|
| **Severidad** | `warn` (aviso: no rompe el build ni el exit code) |
| **Aplica en** | `prod` |
| **Excepción** | Sí (declarada dos veces, con caducidad) |
| **Falla cerrado** | Sí (avisa cuando no puede comprobarlo) |

## Qué verifica

Para toda `AWS::WAFv2::WebACL` del app, dos avisos independientes:

1. **Solo observa:** tiene al menos un `ManagedRuleGroupStatement` de primer nivel y **todos** tienen `OverrideAction: { Count: {} }`. Una ACL en la que ningún grupo administrado bloquea no protege: solo cuenta. Una ACL sin ningún grupo administrado (solo reglas propias) no recibe este aviso.
2. **A ciegas:** ningún `AWS::WAFv2::LoggingConfiguration` tiene un `ResourceArn` que resuelva a la ACL. Sin logging no queda registro de lo que bloquea ni de lo que deja pasar.

**No resoluble (avisa):** un `OverrideAction` que es un intrinsic (y ningún otro grupo bloquea), `Rules` que no es una lista literal, o una `LoggingConfiguration` cuyo `ResourceArn` no resuelve a un recurso del app (podría ser la de esta ACL).

## Por qué

Poner los grupos administrados en count es la práctica correcta **mientras se ajustan** las reglas, y un olvido caro después: meses con una ACL que solo cuenta y un incidente que «el WAF habría parado». El logging es lo que permite ajustar y lo que sirve en un incidente. Es un aviso porque el modo count puede ser deliberado y temporal.

## Cómo corregirlo

Cuando termine el ajuste, `overrideAction: { none: {} }` en los grupos base; y un logging:

```ts
new wafv2.CfnLoggingConfiguration(this, 'WafLogging', {
  resourceArn: webAcl.attrArn,
  logDestinationConfigs: [logGroup.logGroupArn], // el log group se llama aws-waf-logs-…
});
```

Si la ACL está en ajuste a propósito, declare la excepción con caducidad: es lo que obliga a volver a mirarla.

## De dónde viene

Un WAF recién asociado se deja en count para no bloquear tráfico legítimo, y nada obliga a pasarlo a bloqueo. Esta regla lo hace visible en el resumen del workflow sin romper el build.

## Límites conocidos

- Solo mira los grupos administrados de primer nivel y su `OverrideAction`; no inspecciona `RuleActionOverrides` ni el contenido de las reglas propias.
- No comprueba que el destino del logging exista ni que tenga retención (para los log groups, `NX-LOG-001`).
