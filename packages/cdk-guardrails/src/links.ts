// Resolución de referencias ENTRE recursos y entre stacks. Sin red, sin fs, sin aws-cdk-lib: opera sobre el JSON sintetizado.
//
// Un app real se parte en stacks enlazados por `Ref`/`GetAtt` locales, por `Fn::ImportValue` (exports de CloudFormation) y, en el estándar
// de infra de Nextep, por PARÁMETROS SSM (`AWS::SSM::Parameter::Value<String>` con `Default` = nombre del parámetro, que escribe un
// `AWS::SSM::Parameter` de otro stack). Una regla que solo mirara el template local daría falsos positivos con esa arquitectura.
import { HOLE, isObj, Located, Obj, propsOf, staticText } from './cfn';
import type { StackTemplate } from './types';

export interface Resolution {
  /** Recursos del app a los que el valor apunta (siguiendo Ref, GetAtt, ImportValue y parámetros SSM). Sin repetidos. */
  targets: Located[];
  /** true si alguna referencia NO se pudo seguir (parámetro que no es SSM, export o parámetro SSM que el app no declara, Sub con variable ajena). */
  unresolved: boolean;
}

interface Linked {
  stack: string;
  value: unknown;
}
interface Index {
  stacks: Map<string, StackTemplate>;
  exports: Map<string, Linked>;
  ssm: Map<string, Linked>;
}

const cache = new WeakMap<StackTemplate[], Index>();

function indexOf(app: StackTemplate[]): Index {
  const hit = cache.get(app);
  if (hit) return hit;
  const idx: Index = { stacks: new Map(), exports: new Map(), ssm: new Map() };
  for (const s of app) {
    idx.stacks.set(s.stack, s);
    for (const out of Object.values(s.template.Outputs ?? {})) {
      const name = staticText(out?.Export?.Name);
      if (name?.complete && out.Value !== undefined) idx.exports.set(name.text, { stack: s.stack, value: out.Value });
    }
    for (const res of Object.values(s.template.Resources ?? {})) {
      if (res.Type !== 'AWS::SSM::Parameter') continue;
      const p = propsOf(res);
      const name = staticText(p.Name);
      if (name?.complete && p.Value !== undefined) idx.ssm.set(name.text, { stack: s.stack, value: p.Value });
    }
  }
  cache.set(app, idx);
  return idx;
}

const SUB_VAR = /\$\{([^}!][^}]*)\}/g;

/**
 * Recursos del app a los que apunta `value` (un valor de una propiedad de `stack`). Los literales y los pseudo-parámetros (`AWS::Region`,
 * `AWS::Partition`…) no son referencias: no aportan ni a `targets` ni a `unresolved`. Una regla que necesite distinguir «apunta fuera del
 * app» de «apunta a un recurso» mira `targets.length === 0 || unresolved`.
 */
export function resolveTargets(app: StackTemplate[], stack: string, value: unknown): Resolution {
  const idx = indexOf(app);
  const targets = new Map<string, Located>();
  let unresolved = false;
  const visiting = new Set<string>();

  const addLocal = (st: string, id: string): boolean => {
    const res = idx.stacks.get(st)?.template.Resources?.[id];
    if (!res) return false;
    targets.set(`${st}\u0001${id}`, { stack: st, id, res });
    return true;
  };

  const follow = (key: string, linked: Linked | undefined): void => {
    if (!linked) {
      unresolved = true;
      return;
    }
    if (visiting.has(key)) return; // ciclo: ya se está siguiendo
    visiting.add(key);
    walk(linked.value, linked.stack);
    visiting.delete(key);
  };

  const ref = (name: string, st: string): void => {
    if (name.startsWith('AWS::')) return;
    if (addLocal(st, name)) return;
    const param = idx.stacks.get(st)?.template.Parameters?.[name];
    if (param && typeof param.Type === 'string' && param.Type.startsWith('AWS::SSM::Parameter::Value') && typeof param.Default === 'string') {
      follow(`ssm\u0001${param.Default}`, idx.ssm.get(param.Default));
      return;
    }
    unresolved = true;
  };

  const walk = (v: unknown, st: string): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x, st);
      return;
    }
    if (!isObj(v)) return;
    for (const [k, arg] of Object.entries(v)) {
      if (k === 'Ref' && typeof arg === 'string') ref(arg, st);
      else if (k === 'Fn::GetAtt') {
        const id = Array.isArray(arg) ? arg[0] : typeof arg === 'string' ? arg.split('.')[0] : undefined;
        if (typeof id === 'string' && !addLocal(st, id)) unresolved = true;
        if (typeof id !== 'string') unresolved = true;
      } else if (k === 'Fn::ImportValue') {
        const name = staticText(arg);
        if (!name?.complete) unresolved = true;
        else follow(`export\u0001${name.text}`, idx.exports.get(name.text));
      } else if (k === 'Fn::Sub') {
        const [text, vars] = Array.isArray(arg) ? [arg[0], isObj(arg[1]) ? (arg[1] as Obj) : {}] : [arg, {}];
        if (typeof text === 'string') {
          for (const m of text.matchAll(SUB_VAR)) {
            const name = (m[1] as string).split('.')[0] as string;
            if (name in vars) walk(vars[name], st);
            else ref(name, st);
          }
        }
        for (const x of Object.values(vars)) walk(x, st);
      } else walk(arg, st);
    }
  };

  walk(value, stack);
  return { targets: [...targets.values()], unresolved };
}

/** ¿`value` apunta al recurso `stack/id`? */
export function pointsTo(app: StackTemplate[], stack: string, value: unknown, target: { stack: string; id: string }): boolean {
  return resolveTargets(app, stack, value).targets.some((t) => t.stack === target.stack && t.id === target.id);
}

/**
 * Nombre de un valor como texto, para comparar «el nombre que un servicio crea solo» con «el nombre que el app declara» sin conocer el
 * nombre físico: una referencia a un recurso se escribe `<idLógico>`. `complete: false` si quedó algún hueco.
 */
export function renderName(v: unknown): { text: string; complete: boolean } {
  if (typeof v === 'string') return { text: v, complete: true };
  if (!isObj(v)) return { text: HOLE, complete: false };
  if ('Fn::Join' in v) {
    const j = v['Fn::Join'];
    if (!Array.isArray(j) || j.length !== 2 || typeof j[0] !== 'string' || !Array.isArray(j[1])) return { text: HOLE, complete: false };
    const parts = (j[1] as unknown[]).map(renderName);
    return { text: parts.map((p) => p.text).join(j[0]), complete: parts.every((p) => p.complete) };
  }
  if (typeof v.Ref === 'string') {
    if (v.Ref === 'AWS::Partition') return { text: 'aws', complete: true };
    if (v.Ref.startsWith('AWS::')) return { text: HOLE, complete: false };
    return { text: `<${v.Ref}>`, complete: true };
  }
  const att = v['Fn::GetAtt'];
  if (Array.isArray(att) && typeof att[0] === 'string') return { text: `<${att[0]}>`, complete: true };
  return { text: HOLE, complete: false };
}

/** `true`/`"true"` → true, `false`/`"false"` → false, cualquier otra cosa (incluido un intrinsic) → undefined. */
export function literalBool(v: unknown): boolean | undefined {
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return undefined;
}
