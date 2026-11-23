import { Located, ofType, propsOf, where } from '../cfn';
import { pointsTo, resolveTargets } from '../links';
import { Finding, Rule, StackTemplate } from '../types';

const ACTION_PROPS = ['AlarmActions', 'OKActions', 'InsufficientDataActions'] as const;
const CHATBOT_TYPES = ['AWS::Chatbot::SlackChannelConfiguration', 'AWS::Chatbot::MicrosoftTeamsChannelConfiguration'];

/**
 * NX-ALM-001 (aviso): todo topic de SNS usado como destino de alarmas de CloudWatch tiene al menos un suscriptor en el app. Un topic de alarmas
 * sin suscriptor son alarmas mudas: la alarma salta y nadie se entera.
 *
 * El «es destino de alarmas» se deduce de las alarmas del app, siguiendo las referencias (incluido el salto por parámetros SSM, que es como los
 * stacks de referencia pasan el topic). Un destino que no resuelve a un topic del app no es sujeto: no se puede saber si está mudo. Suscriptor =
 * un `AWS::SNS::Subscription`, la propiedad inline `Subscription` del topic, o una configuración de AWS Chatbot (se suscribe sola).
 */
export const rule: Rule = {
  id: 'NX-ALM-001',
  title: 'Todo topic de alarmas tiene al menos un suscriptor',
  severity: 'warn',
  appliesTo: ['prod'],
  allowsException: true,
  failsClosed: true,
  check(app: StackTemplate[]) {
    const findings: Finding[] = [];
    const topics = new Map<string, { topic: Located; alarms: Located[] }>();
    for (const alarm of [...ofType(app, 'AWS::CloudWatch::Alarm'), ...ofType(app, 'AWS::CloudWatch::CompositeAlarm')]) {
      const p = propsOf(alarm.res);
      for (const prop of ACTION_PROPS) {
        for (const t of resolveTargets(app, alarm.stack, p[prop]).targets) {
          if (t.res.Type !== 'AWS::SNS::Topic') continue;
          const k = `${t.stack}\u0001${t.id}`;
          const hit = topics.get(k) ?? { topic: t, alarms: [] };
          if (!hit.alarms.some((a) => a.stack === alarm.stack && a.id === alarm.id)) hit.alarms.push(alarm);
          topics.set(k, hit);
        }
      }
    }

    const subs = ofType(app, 'AWS::SNS::Subscription');
    const chatbots = CHATBOT_TYPES.flatMap((t) => ofType(app, t));
    for (const { topic, alarms } of topics.values()) {
      const p = propsOf(topic.res);
      const used = `lo usa ${alarms.length === 1 ? 'la alarma' : `${alarms.length} alarmas, p. ej.`} ${alarms[0]!.stack}/${alarms[0]!.id}`;
      const at = (msg: string): Finding => ({ stack: topic.stack, resource: topic.id, message: `[NX-ALM-001] ${where(topic)}: ${msg} Ver docs/rules/NX-ALM-001.md` });

      if (Array.isArray(p.Subscription) && p.Subscription.length > 0) continue;
      if (subs.some((s) => pointsTo(app, s.stack, propsOf(s.res).TopicArn, topic))) continue;
      if (chatbots.some((c) => pointsTo(app, c.stack, propsOf(c.res).SnsTopicArns, topic))) continue;

      // Una suscripción cuyo TopicArn no se puede seguir podría ser de este topic.
      const opaque = subs.filter((s) => {
        const r = resolveTargets(app, s.stack, propsOf(s.res).TopicArn);
        return r.targets.length === 0 || r.unresolved;
      });
      if (p.Subscription !== undefined && !Array.isArray(p.Subscription)) {
        findings.push(at(`${used}; no se puede comprobar su propiedad Subscription (no es una lista literal).`));
      } else if (opaque.length) {
        findings.push(at(`${used}; ninguna suscripción lo referencia y no se puede comprobar si la de ${opaque.map((s) => `${s.stack}/${s.id}`).join(', ')} es la suya (TopicArn no resuelve a un recurso del app).`));
      } else {
        findings.push(at(`${used} y no tiene ninguna suscripción en el app: las alarmas saltan y nadie se entera. Agregue al menos un AWS::SNS::Subscription (correo, SMS, HTTPS, Lambda) o una configuración de AWS Chatbot.`));
      }
    }
    return findings;
  },
};
