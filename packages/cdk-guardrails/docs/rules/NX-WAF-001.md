# NX-WAF-001 — En `prod` todo ALB internet-facing tiene WAF asociado

| | |
|---|---|
| **Severidad** | `error` |
| **Aplica en** | `prod` |
| **Excepción** | Sí (declarada dos veces, con caducidad) |
| **Falla cerrado** | Sí (caso «no resoluble») |

## Qué verifica

Todo `AWS::ElasticLoadBalancingV2::LoadBalancer` **expuesto a internet** tiene un `AWS::WAFv2::WebACLAssociation` cuyo `ResourceArn` lo referencia (por `Ref`, `GetAtt`, o a través de un export o parámetro SSM de otro stack).

**Sujeto:** `Type: application` (o ausente: es el default) y `Scheme: internet-facing` (o ausente: es el default de CloudFormation). **No son sujeto:** los balanceadores `internal`, y los de tipo `network` o `gateway` (WAFv2 solo se asocia a un ALB).

**No resoluble (falla cerrado):**

- `Type` o `Scheme` como intrinsic: no se sabe si el balanceador es de cara a internet; se asume que lo es y se exige WAF.
- El ALB no tiene asociación, pero existe alguna cuyo `ResourceArn` **no resuelve a ningún recurso del app** (un ARN literal, un parámetro, un export ajeno): no se puede descartar que sea la suya, y el mensaje nombra esa asociación. Referencie el balanceador con `Ref`/`GetAtt`.

## Por qué

Un ALB público sin WAF deja pasar al servicio detrás toda la basura de internet: inyecciones, bots, abusos de tasa. El WAF con las reglas administradas base y un límite de tasa es la defensa mínima que no cuesta casi nada.

## Cómo corregirlo

```ts
new wafv2.CfnWebACLAssociation(this, 'WafAssociation', {
  resourceArn: alb.loadBalancerArn,
  webAclArn: webAcl.attrArn,
});
```

La ACL debe ser regional (`scope: 'REGIONAL'`). Si el balanceador está detrás de CloudFront con la protección en la distribución, declare la excepción (dos veces, con motivo, dueño y caducidad).

## De dónde viene

Estándar de borde de producción: todo punto de entrada público pasa por un WAF. Complementa `NX-WAF-002`, que mira que la ACL bloquee y registre.

## Límites conocidos

- Solo mira ALB. CloudFront y API Gateway tienen su propio punto de asociación y no son sujeto de esta regla.
- No comprueba que la `WebACLArn` apunte a una ACL del app ni que tenga reglas: eso lo juzga `NX-WAF-002` sobre las ACL que el app declara.
