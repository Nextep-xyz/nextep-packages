import * as fs from 'fs';
import * as path from 'path';
import { discover, REPO_ROOT } from '@governance/gates/_discovery';
import { checkRuleInventory, FixtureCase, MIN_RULES, RuleFacts, RuleInventory } from '@governance/lib/guardrails-rules';

// GR1 (spec cdk-guardrails §3): toda regla de packages/cdk-guardrails/src/rules/ (descubierta por DISCO) tiene id NX-… único,
// severidad, appliesTo, documentación en docs/rules/<id>.md y al menos un fixture que falla y uno que pasa. Falla si descubre
// menos de 18 reglas (MIN_RULES), y falla si una regla existe en disco pero no está registrada en ALL_RULES (no correría nunca).
// GR2 y GR3 (cada regla en rojo nombrando stack y recurso; NX-POWER-001 sin excepción) viven en packages/cdk-guardrails/test/.

const PKG = 'packages/cdk-guardrails';

const BASE_RULE: RuleFacts = { file: `${PKG}/src/rules/NX-AAA-001.ts`, id: 'NX-AAA-001', title: 't', severity: 'error', appliesTo: ['dev'], allowsException: true };
const DOC = '## Qué verifica\n## Por qué\n## Cómo corregirlo\n## De dónde viene\n';
const CASE: FixtureCase = { templates: ['S.template.json'], hasContext: true };
const goodInventory = (): RuleInventory => ({
  rules: Array.from({ length: MIN_RULES }, (_, i) => {
    const id = `NX-AAA-${String(i + 1).padStart(3, '0')}`;
    return { ...BASE_RULE, id, file: `${PKG}/src/rules/${id}.ts` };
  }),
  docs: {},
  fixtures: {},
  registryIds: [],
});
function complete(inv: RuleInventory): RuleInventory {
  for (const r of inv.rules) {
    const id = r.id as string;
    inv.docs[id] = DOC;
    inv.fixtures[id] = { fail: { ...CASE, expectedCount: 1 }, pass: CASE };
    inv.registryIds.push(id);
  }
  return inv;
}

describe('GR1: la lógica (unit)', () => {
  it('un inventario completo no produce problemas', () => {
    expect(checkRuleInventory(complete(goodInventory()))).toEqual([]);
  });

  it('0 reglas descubiertas: falla (un gate sin sujetos no prueba nada)', () => {
    expect(checkRuleInventory({ rules: [], docs: {}, fixtures: {}, registryIds: [] }).join('\n')).toMatch(/ninguna regla/);
  });

  it(`menos de ${MIN_RULES} reglas: falla con el conteo`, () => {
    const inv = complete(goodInventory());
    inv.rules.pop();
    expect(checkRuleInventory(inv).join('\n')).toMatch(new RegExp(`${MIN_RULES - 1} reglas.*al menos ${MIN_RULES}`));
  });

  it('falta el doc de una regla: nombra la regla y la ruta', () => {
    const inv = complete(goodInventory());
    delete inv.docs['NX-AAA-003'];
    expect(checkRuleInventory(inv).join('\n')).toMatch(/NX-AAA-003: falta docs\/rules\/NX-AAA-003\.md/);
  });

  it('un doc sin las secciones obligatorias: nombra cuáles faltan', () => {
    const inv = complete(goodInventory());
    inv.docs['NX-AAA-002'] = '## Qué verifica\n';
    expect(checkRuleInventory(inv).join('\n')).toMatch(/NX-AAA-002: .*\[## Por qué, ## Cómo corregirlo, ## De dónde viene\]/);
  });

  it.each(['fail', 'pass'] as const)('falta el fixture %s: nombra la regla y el directorio', (kind) => {
    const inv = complete(goodInventory());
    delete inv.fixtures['NX-AAA-004']![kind];
    expect(checkRuleInventory(inv).join('\n')).toMatch(new RegExp(`NX-AAA-004: falta el fixture ${kind} \\(fixtures/NX-AAA-004/${kind}/\\)`));
  });

  it('un fixture sin templates, sin context.json o sin expected: falla', () => {
    const inv = complete(goodInventory());
    inv.fixtures['NX-AAA-001'] = { fail: { templates: [], hasContext: false, expectedCount: 0 }, pass: CASE };
    const out = checkRuleInventory(inv).join('\n');
    expect(out).toMatch(/NX-AAA-001: fixtures\/NX-AAA-001\/fail\/ no tiene ningún \*\.template\.json/);
    expect(out).toMatch(/NX-AAA-001: fixtures\/NX-AAA-001\/fail\/ no tiene context\.json/);
    expect(out).toMatch(/NX-AAA-001: fixtures\/NX-AAA-001\/fail\/expected\.json/);
  });

  it('id mal formado, nombre de archivo distinto del id y id duplicado: nombran el archivo', () => {
    const inv = complete(goodInventory());
    inv.rules[0] = { ...BASE_RULE, id: 'nx-1', file: `${PKG}/src/rules/malo.ts` };
    inv.rules[1] = { ...BASE_RULE, id: 'NX-AAA-003', file: `${PKG}/src/rules/NX-AAA-002.ts` };
    const out = checkRuleInventory(inv).join('\n');
    expect(out).toMatch(/malo\.ts: el id "nx-1" no cumple/);
    expect(out).toMatch(/NX-AAA-002\.ts: el nombre del archivo debe ser el id/);
    expect(out).toMatch(/NX-AAA-003.*duplicado/);
  });

  it('severity, appliesTo y allowsException inválidos: nombran el archivo', () => {
    const inv = complete(goodInventory());
    inv.rules[0] = { ...(inv.rules[0] as RuleFacts), severity: 'info', appliesTo: [], allowsException: 'si' };
    const out = checkRuleInventory(inv).join('\n');
    expect(out).toMatch(/NX-AAA-001\.ts: severity "info" inválida/);
    expect(out).toMatch(/NX-AAA-001\.ts: appliesTo debe ser/);
    expect(out).toMatch(/NX-AAA-001\.ts: allowsException debe ser/);
  });

  it('doc o fixtures de una regla que ya no existe (obsoletos): fallan', () => {
    const inv = complete(goodInventory());
    inv.docs['NX-OLD-001'] = DOC;
    inv.fixtures['NX-OLD-002'] = { fail: CASE };
    const out = checkRuleInventory(inv).join('\n');
    expect(out).toMatch(/docs\/rules\/NX-OLD-001\.md: documenta una regla que no existe/);
    expect(out).toMatch(/fixtures\/NX-OLD-002\/: fixtures de una regla que no existe/);
  });

  it('una regla en disco que no está en ALL_RULES falla nombrándola; y al revés', () => {
    const inv = complete(goodInventory());
    inv.registryIds = inv.registryIds.filter((id) => id !== 'NX-AAA-005').concat('NX-GHOST-001');
    const out = checkRuleInventory(inv).join('\n');
    expect(out).toMatch(/NX-AAA-005: existe src\/rules\/NX-AAA-005\.ts pero no está en ALL_RULES/);
    expect(out).toMatch(/ALL_RULES incluye NX-GHOST-001/);
  });
});

// --- El gate: recorre el disco ---------------------------------------------------------------------------------------------

function readCase(dir: string): FixtureCase | undefined {
  const abs = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(abs)) return undefined;
  const files = fs.readdirSync(abs);
  const expected = files.includes('expected.json') ? (JSON.parse(fs.readFileSync(path.join(abs, 'expected.json'), 'utf8')) as unknown[]) : undefined;
  return { templates: files.filter((f) => f.endsWith('.template.json')), hasContext: files.includes('context.json'), expectedCount: expected?.length };
}

function buildInventory(): RuleInventory {
  const ruleFiles = discover([`${PKG}/src/rules/NX-*.ts`], { min: MIN_RULES });
  const rules: RuleFacts[] = ruleFiles.map((file) => {
    const mod = require(path.join(REPO_ROOT, file)) as { rule?: Record<string, unknown> };
    const r = mod.rule ?? {};
    return { file, id: r.id, title: r.title, severity: r.severity, appliesTo: r.appliesTo, allowsException: r.allowsException, failsClosed: r.failsClosed };
  });
  const docs: Record<string, string> = {};
  for (const f of fs.existsSync(path.join(REPO_ROOT, PKG, 'docs', 'rules')) ? fs.readdirSync(path.join(REPO_ROOT, PKG, 'docs', 'rules')) : []) {
    if (f.endsWith('.md')) docs[f.replace(/\.md$/, '')] = fs.readFileSync(path.join(REPO_ROOT, PKG, 'docs', 'rules', f), 'utf8');
  }
  const fixtures: RuleInventory['fixtures'] = {};
  const fxRoot = path.join(REPO_ROOT, PKG, 'fixtures');
  for (const id of fs.existsSync(fxRoot) ? fs.readdirSync(fxRoot) : []) {
    if (!fs.statSync(path.join(fxRoot, id)).isDirectory() || !id.startsWith('NX-')) continue; // otros directorios (p. ej. dashboard/, de F2) no son de una regla
    fixtures[id] = {
      fail: readCase(`${PKG}/fixtures/${id}/fail`),
      pass: readCase(`${PKG}/fixtures/${id}/pass`),
      unresolvable: readCase(`${PKG}/fixtures/${id}/fail-unresolvable`),
    };
  }
  const registry = (require(path.join(REPO_ROOT, PKG, 'src', 'rules', 'index.ts')) as { ALL_RULES: { id: string }[] }).ALL_RULES;
  const readme = fs.readFileSync(path.join(REPO_ROOT, PKG, 'README.md'), 'utf8');
  return { rules, docs, fixtures, registryIds: registry.map((r) => r.id), readme };
}

describe('GR1: forma del id (unit)', () => {
  it.each(['NX-S3-001', 'NX-BKP-002', 'NX-POWER-005'])('%s es un id válido', (id) => {
    const inv = complete(goodInventory());
    inv.rules[0] = { ...(inv.rules[0] as RuleFacts), id, file: `${PKG}/src/rules/${id}.ts` };
    inv.docs[id] = DOC;
    inv.fixtures[id] = { fail: { ...CASE, expectedCount: 1 }, pass: CASE };
    inv.registryIds.push(id);
    expect(checkRuleInventory(inv).filter((p) => p.includes(id) && p.includes('no cumple'))).toEqual([]);
  });

  it.each(['NX-3S-001', 'NX--001', 'NX-S3-01', 'nx-s3-001'])('%s es un id inválido: nombra el archivo', (id) => {
    const inv = complete(goodInventory());
    inv.rules[0] = { ...(inv.rules[0] as RuleFacts), id, file: `${PKG}/src/rules/${id}.ts` };
    expect(checkRuleInventory(inv).join('\n')).toMatch(new RegExp(`${id}\\.ts: el id "${id}" no cumple`));
  });
});

describe('GR1: failsClosed y README (unit)', () => {
  it('una regla con failsClosed sin fixture fail-unresolvable: falla nombrando la regla y el directorio', () => {
    const inv = complete(goodInventory());
    inv.rules[2] = { ...(inv.rules[2] as RuleFacts), failsClosed: true };
    expect(checkRuleInventory(inv).join('\n')).toMatch(/NX-AAA-003: declara failsClosed pero falta el fixture no resoluble \(fixtures\/NX-AAA-003\/fail-unresolvable\/\)/);
  });

  it('con el fixture completo pasa; sin context o sin expected falla', () => {
    const inv = complete(goodInventory());
    inv.rules[2] = { ...(inv.rules[2] as RuleFacts), failsClosed: true };
    inv.fixtures['NX-AAA-003']!.unresolvable = { ...CASE, expectedCount: 1 };
    expect(checkRuleInventory(inv)).toEqual([]);
    inv.fixtures['NX-AAA-003']!.unresolvable = { templates: ['S.template.json'], hasContext: false, expectedCount: 0 };
    const out = checkRuleInventory(inv).join('\n');
    expect(out).toMatch(/NX-AAA-003: fixtures\/NX-AAA-003\/fail-unresolvable\/ no tiene context\.json/);
    expect(out).toMatch(/NX-AAA-003: fixtures\/NX-AAA-003\/fail-unresolvable\/expected\.json/);
  });

  it('failsClosed que no es booleano: falla nombrando el archivo', () => {
    const inv = complete(goodInventory());
    inv.rules[0] = { ...(inv.rules[0] as RuleFacts), failsClosed: 'si' };
    expect(checkRuleInventory(inv).join('\n')).toMatch(/NX-AAA-001\.ts: failsClosed debe ser true o false/);
  });

  it('una regla que el README no lista: falla nombrándola; con todas listadas pasa', () => {
    const inv = complete(goodInventory());
    inv.readme = inv.rules.map((r) => `\`${r.id as string}\``).join(' ');
    expect(checkRuleInventory(inv)).toEqual([]);
    inv.readme = inv.readme.replace('`NX-AAA-004`', '');
    expect(checkRuleInventory(inv).join('\n')).toMatch(/NX-AAA-004: el catálogo del README del paquete no lista la regla/);
  });
});

describe('GR1: el gate (descubrimiento por disco)', () => {
  it(`descubre al menos ${MIN_RULES} reglas y cada una cumple el contrato (id, severidad, appliesTo, doc, fixtures fail/pass, registro)`, () => {
    expect(checkRuleInventory(buildInventory())).toEqual([]);
  });
});
