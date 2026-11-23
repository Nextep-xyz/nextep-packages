# NX-ALM-001 — Todo topic de alarmas tiene al menos un suscriptor

| | |
|---|---|
| **Severidad** | `warn` (aviso: no rompe el build ni el exit code) |
| **Aplica en** | `prod` |
| **Excepción** | Sí (declarada dos veces, con caducidad) |
| **Falla cerrado** | Sí (avisa cuando no puede comprobarlo) |

## Qué verifica

Todo `AWS::SNS::Topic` del app que es **destino de alarmas** tiene al menos un suscriptor en el app.

- **Es destino de alarmas** si aparece en `AlarmActions`, `OKActions` o `InsufficientDataActions` de un `AWS::CloudWatch::Alarm` o `AWS::CloudWatch::CompositeAlarm`. Las referencias se siguen entre stacks: `Ref`/`GetAtt`, `Fn::ImportValue` y **parámetros SSM** (que es como los stacks de referencia pasan el topic de alarmas: la alarma lleva un parámetro `AWS::SSM::Parameter::Value` y otro stack escribe el ARN en ese nombre).
- **Suscriptor** es cualquiera de: un `AWS::SNS::Subscription` cuyo `TopicArn` resuelve al topic; la propiedad inline `Subscription` del topic con al menos un elemento; una configuración de AWS Chatbot (`AWS::Chatbot::SlackChannelConfiguration` o `MicrosoftTeamsChannelConfiguration`) que lo lista en `SnsTopicArns` (Chatbot se suscribe solo).

Un destino que **no** resuelve a un topic del app (un ARN literal, un topic importado de fuera) **no es sujeto**: no se puede saber si está mudo, y la regla no inventa un hallazgo sobre algo que no declara el app.

**No resoluble (avisa):** una suscripción cuyo `TopicArn` no resuelve a un recurso del app (podría ser la de este topic) o una propiedad `Subscription` que es un intrinsic.

## Por qué

Una alarma sin quién la escuche no es una alarma: salta, CloudWatch la marca en rojo y nadie se entera hasta que un cliente avisa. El topic y las alarmas se despliegan fácil; la suscripción (que además pide confirmar un correo) se olvida.

## Cómo corregirlo

```ts
topic.addSubscription(new subs.EmailSubscription('ops@example.com'));
```

o una configuración de Chatbot para Slack/Teams. Si la suscripción vive fuera del app a propósito (otro repo, alta manual), declare la excepción con motivo, dueño y caducidad.

## De dónde viene

Un `cdk deploy` de infraestructura de observabilidad crea topic y alarmas, y la suscripción se deja «para después». La regla convierte ese «después» en un aviso visible.

## Límites conocidos

- Solo ve los suscriptores que el app declara. Una suscripción creada a mano da aviso: es justo lo que la regla quiere hacer visible.
- No comprueba que la suscripción esté **confirmada** (un correo sin confirmar sigue mudo): eso no se ve en el template.
- Los destinos que no son SNS (acciones de EC2, Auto Scaling, Systems Manager) no son sujeto.
