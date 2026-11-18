// Lógica pura del gate GR1 (spec cdk-guardrails §3): inventario de reglas de @nextep/cdk-guardrails → problemas.
// El gate (governance/gates/guardrails-rules.spec.ts) arma el inventario recorriendo el disco; aquí solo se juzga.

export const MIN_RULES = 8;
export const RULE_ID = /^NX-[A-Z]+-\d{3}$/;
export const VALID_SEVERITIES = ['error', 'warn'];
export const VALID_STAGES = ['dev', 'stg', 'prod', 'shared'];
/** Secciones que todo `docs/rules/<id>.md` debe tener (spec F1 tarea 3: qué, por qué, cómo corregirlo, de dónde viene). */
export const REQUIRED_DOC_HEADINGS = ['## Qué verifica', '## Por qué', '## Cómo corregirlo', '## De dónde viene'];

export interface RuleFacts {
  /** Ruta relativa del archivo de la regla (src/rules/NX-XXX-000.ts). */
  file: string;
  id: unknown;
  title: unknown;
  severity: unknown;
  appliesTo: unknown;
  allowsException: unknown;
}

export interface FixtureCase {
  /** Nombres de los `*.template.json` del caso. */
  templates: string[];
  hasContext: boolean;
  /** Solo para los casos `fail`: número de entradas de expected.json (undefined si no existe). */
  expectedCount?: number;
}

export interface RuleInventory {
  rules: RuleFacts[];
  /** id → contenido del `docs/rules/<id>.md`. */
  docs: Record<string, string>;
  /** id → { fail?, pass? } descubiertos en `fixtures/<id>/`. */
  fixtures: Record<string, { fail?: FixtureCase; pass?: FixtureCase }>;
  /** ids que exporta `ALL_RULES` (src/rules/index.ts). */
  registryIds: string[];
}

export function checkRuleInventory(inv: RuleInventory): string[] {
  const p: string[] = [];
  if (inv.rules.length === 0) return ['no se descubrió ninguna regla en src/rules/NX-*.ts: un gate sin sujetos no prueba nada'];
  if (inv.rules.length < MIN_RULES) p.push(`se descubrieron ${inv.rules.length} reglas; el catálogo inicial exige al menos ${MIN_RULES} (spec §2.3)`);

  const seen = new Map<string, string>();
  const ids: string[] = [];
  for (const r of inv.rules) {
    if (typeof r.id !== 'string' || !RULE_ID.test(r.id)) {
      p.push(`${r.file}: el id ${JSON.stringify(r.id)} no cumple NX-<ÁREA>-<NNN>`);
      continue;
    }
    ids.push(r.id);
    const stem = r.file.split('/').pop()!.replace(/\.ts$/, '');
    if (stem !== r.id) p.push(`${r.file}: el nombre del archivo debe ser el id de la regla (${r.id}.ts)`);
    if (seen.has(r.id)) p.push(`${r.file}: el id ${r.id} está duplicado (también en ${seen.get(r.id)})`);
    seen.set(r.id, r.file);
    if (typeof r.title !== 'string' || r.title.trim() === '') p.push(`${r.file}: falta el title`);
    if (typeof r.severity !== 'string' || !VALID_SEVERITIES.includes(r.severity)) p.push(`${r.file}: severity ${JSON.stringify(r.severity)} inválida (error | warn)`);
    if (!Array.isArray(r.appliesTo) || r.appliesTo.length === 0 || !r.appliesTo.every((s) => VALID_STAGES.includes(s as string))) {
      p.push(`${r.file}: appliesTo debe ser una lista no vacía de ${VALID_STAGES.join(' | ')}`);
    }
    if (typeof r.allowsException !== 'boolean') p.push(`${r.file}: allowsException debe ser true o false`);
  }

  for (const id of ids) {
    const doc = inv.docs[id];
    if (doc === undefined) p.push(`${id}: falta docs/rules/${id}.md`);
    else {
      const missing = REQUIRED_DOC_HEADINGS.filter((h) => !doc.includes(h));
      if (missing.length) p.push(`${id}: docs/rules/${id}.md no tiene la(s) sección(es) [${missing.join(', ')}]`);
    }
    const fx = inv.fixtures[id] ?? {};
    for (const kind of ['fail', 'pass'] as const) {
      const c = fx[kind];
      if (!c) p.push(`${id}: falta el fixture ${kind} (fixtures/${id}/${kind}/)`);
      else {
        if (c.templates.length === 0) p.push(`${id}: fixtures/${id}/${kind}/ no tiene ningún *.template.json`);
        if (!c.hasContext) p.push(`${id}: fixtures/${id}/${kind}/ no tiene context.json`);
      }
    }
    if (fx.fail && (fx.fail.expectedCount === undefined || fx.fail.expectedCount < 1)) {
      p.push(`${id}: fixtures/${id}/fail/expected.json debe listar al menos un «stack/recurso» esperado`);
    }
  }

  // Obsoletos: documentación o fixtures de una regla que ya no existe (mismo criterio que las excepciones: nada queda huérfano).
  const idSet = new Set(ids);
  for (const id of Object.keys(inv.docs)) if (!idSet.has(id)) p.push(`docs/rules/${id}.md: documenta una regla que no existe en src/rules/`);
  for (const id of Object.keys(inv.fixtures)) if (!idSet.has(id)) p.push(`fixtures/${id}/: fixtures de una regla que no existe en src/rules/`);

  // El registro (ALL_RULES) debe coincidir con lo que hay en disco: una regla nueva que nadie registró no correría nunca.
  const reg = new Set(inv.registryIds);
  for (const id of ids) if (!reg.has(id)) p.push(`${id}: existe src/rules/${id}.ts pero no está en ALL_RULES (src/rules/index.ts): la regla no correría`);
  for (const id of inv.registryIds) if (!idSet.has(id)) p.push(`ALL_RULES incluye ${id}, que no tiene archivo en src/rules/`);
  return p;
}
