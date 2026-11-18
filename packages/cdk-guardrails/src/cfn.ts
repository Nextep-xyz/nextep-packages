// Helpers puros para leer un template de CloudFormation. Sin red, sin fs, sin aws-cdk-lib.
import type { CfnResource, StackTemplate } from './types';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Carácter que ocupa el lugar de un intrinsic que no se puede resolver estáticamente. */
export const HOLE = '\u0000';

export interface Located {
  stack: string;
  id: string;
  res: CfnResource;
}

export function allResources(app: StackTemplate[]): Located[] {
  return app.flatMap((s) => Object.entries(s.template.Resources ?? {}).map(([id, res]) => ({ stack: s.stack, id, res })));
}

export function ofType(app: StackTemplate[], type: string): Located[] {
  return allResources(app).filter((l) => l.res.Type === type);
}

export const propsOf = (res: CfnResource): Obj => (isObj(res.Properties) ? res.Properties : {});

/** `<stack>/<recurso> (<tipo>)`: lo que cada mensaje de violación lleva para nombrar al culpable. */
export const where = (l: Located): string => `${l.stack}/${l.id} (${l.res.Type})`;

export function numberOf(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v);
  return undefined;
}

/**
 * Resuelve un valor del template a texto cuando es posible: un literal, `Fn::Join` de partes resolubles y `Ref: AWS::Partition`
 * (la forma real del `Target.Arn` de un target universal de Scheduler, spikes S3-A). Todo lo demás deja un hueco y marca el
 * resultado como incompleto: una regla nunca debe tratar «no pude leerlo» como «no coincide».
 */
export function staticText(v: unknown): { text: string; complete: boolean } | undefined {
  if (typeof v === 'string') return { text: v, complete: true };
  if (!isObj(v)) return undefined;
  if ('Fn::Join' in v) {
    const j = v['Fn::Join'];
    if (!Array.isArray(j) || j.length !== 2 || typeof j[0] !== 'string' || !Array.isArray(j[1])) return { text: HOLE, complete: false };
    const parts = (j[1] as unknown[]).map((p) => staticText(p) ?? { text: HOLE, complete: false });
    return { text: parts.map((p) => p.text).join(j[0]), complete: parts.every((p) => p.complete) };
  }
  if (v.Ref === 'AWS::Partition') return { text: 'aws', complete: true };
  return { text: HOLE, complete: false };
}

export interface UniversalTarget {
  service: string;
  action: string;
  /** false si la acción depende de un intrinsic que no se pudo resolver. */
  complete: boolean;
}

/** Si `arn` es un target universal de Scheduler (`…:scheduler:::aws-sdk:<servicio>:<acción>`), devuelve servicio y acción. */
export function universalTarget(arn: unknown): UniversalTarget | undefined {
  const st = staticText(arn);
  if (!st || !st.text.includes(':aws-sdk:')) return undefined;
  const m = /:aws-sdk:([a-z0-9-]+):([^:]*)$/i.exec(st.text);
  if (!m) return { service: '', action: '', complete: false };
  const action = m[2] as string;
  return { service: m[1] as string, action, complete: action.length > 0 && !action.includes(HOLE) };
}

/** `Properties.Tags` normalizado a mapa. CloudFormation usa lista de {Key,Value} casi siempre y mapa en SSM::Parameter (spikes S3-B). */
export function tagMap(props: Obj | undefined): Record<string, unknown> | undefined {
  const tags = props?.Tags;
  if (Array.isArray(tags)) {
    const out: Record<string, unknown> = {};
    for (const t of tags) if (isObj(t) && typeof t.Key === 'string') out[t.Key] = t.Value;
    return out;
  }
  if (isObj(tags)) {
    const keys = Object.keys(tags);
    if (keys.length === 1 && (keys[0] === 'Ref' || (keys[0] as string).startsWith('Fn::'))) return undefined; // intrinsic: no evaluable
    return { ...tags };
  }
  return undefined;
}

/** ¿El ScalableTarget puede dejar el servicio en 0? `MinCapacity: 0` o una acción programada con `MaxCapacity: 0`. */
export function scalesToZero(props: Obj): boolean {
  if (numberOf(props.MinCapacity) === 0) return true;
  const actions = Array.isArray(props.ScheduledActions) ? (props.ScheduledActions as unknown[]) : [];
  return actions.some((a) => isObj(a) && isObj(a.ScalableTargetAction) && numberOf(a.ScalableTargetAction.MaxCapacity) === 0);
}

/** ¿`value` referencia el recurso `id` (por `Ref` o `Fn::GetAtt`)? Recorre el árbol completo. */
export function referencesLogicalId(value: unknown, id: string): boolean {
  if (Array.isArray(value)) return value.some((v) => referencesLogicalId(v, id));
  if (!isObj(value)) return false;
  if (value.Ref === id) return true;
  const att = value['Fn::GetAtt'];
  if (Array.isArray(att) && att[0] === id) return true;
  if (typeof att === 'string' && att.startsWith(`${id}.`)) return true;
  return Object.values(value).some((v) => referencesLogicalId(v, id));
}

export type Cadence = 'restricted' | 'unrestricted' | 'one-shot' | 'unknown';

const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const dayNumber = (t: string): number => {
  if (/^[1-7]$/.test(t)) return Number(t);
  const i = DAY_NAMES.indexOf(t);
  return i < 0 ? NaN : i + 1;
};

/** Cadencia del campo día-de-la-semana de un cron de EventBridge (SUN=1 … SAT=7). */
function weekdayCadence(field: string): Cadence {
  const days = new Set<number>();
  let partial = false;
  for (const tok of field.toUpperCase().split(',')) {
    if (tok === '*' || tok === '?') return 'unrestricted';
    if (tok === 'L') {
      partial = true;
      continue;
    }
    const nth = /^([1-7]|[A-Z]{3})(#[1-5]|L)$/.exec(tok); // 6L = último viernes del mes, FRI#3 = tercer viernes
    if (nth && !Number.isNaN(dayNumber(nth[1] as string))) {
      partial = true;
      continue;
    }
    const step = /^(\*|[^/-]+(?:-[^/]+)?)(?:\/(\d+))?$/.exec(tok);
    if (!step) return 'unknown';
    const range = step[1] as string;
    const by = step[2] ? Number(step[2]) : 1;
    if (by < 1) return 'unknown';
    let from: number;
    let to: number;
    if (range === '*') {
      from = 1;
      to = 7;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-') as [string, string];
      from = dayNumber(a);
      to = dayNumber(b);
    } else {
      from = dayNumber(range);
      to = step[2] ? 7 : from;
    }
    if (Number.isNaN(from) || Number.isNaN(to)) return 'unknown';
    const span = ((to - from + 7) % 7) + 1; // el rango puede dar la vuelta (FRI-MON)
    for (let k = 0; k < span; k += by) days.add(((from - 1 + k) % 7) + 1);
  }
  if (days.size >= 7) return 'unrestricted';
  return days.size > 0 || partial ? 'restricted' : 'unknown';
}

/** ¿La expresión de Scheduler restringe el día de la semana? `rate()` y los cron de todos los días no; `at()` es de una sola vez. */
export function scheduleCadence(expr: string): Cadence {
  const s = expr.trim();
  if (/^at\(.+\)$/i.test(s)) return 'one-shot';
  if (/^rate\(.+\)$/i.test(s)) return 'unrestricted';
  const m = /^cron\((.+)\)$/i.exec(s);
  if (!m) return 'unknown';
  const f = (m[1] as string).trim().split(/\s+/);
  if (f.length !== 6) return 'unknown';
  return weekdayCadence(f[4] as string);
}
