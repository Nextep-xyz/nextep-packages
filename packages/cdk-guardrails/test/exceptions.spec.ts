import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { allowException } from '@guardrails/src/exceptions/allow';
import { parseExceptionsYaml } from '@guardrails/src/exceptions/yaml';
import { evaluate } from '@guardrails/src/engine';
import type { ExceptionEntry, GuardrailsContext } from '@guardrails/src/types';
import { NOW, oneStack } from '@guardrails/test/helpers';

const ctx = (exceptions: ExceptionEntry[] = [], stage: GuardrailsContext['stage'] = 'dev'): GuardrailsContext => ({ stage, exceptions, now: NOW });
const entry = (over: Partial<ExceptionEntry> = {}): ExceptionEntry => ({
  id: 'EXC-1',
  guard: 'NX-COST-002',
  reason: 'Instancia efímera de pruebas de carga',
  owner: 'devops',
  expires: '2027-01-01',
  ...over,
});
const micro = (...ids: string[]) => ({
  Type: 'AWS::RDS::DBInstance',
  Properties: { DBInstanceClass: 'db.t4g.micro' },
  ...(ids.length ? { Metadata: { 'nextep:exception': ids } } : {}),
});
const hygiene = (res: ReturnType<typeof evaluate>, id: string) => res.filter((v) => v.ruleId === id);

// GR5 (spec cdk-guardrails §3): marca sin entrada, entrada sin marca, entrada vencida y excepción sobre una regla que no la admite
// fallan, cada una nombrando el recurso o el id.
describe('GR5: la declaración doble se verifica en ambos sentidos', () => {
  it('marca SIN entrada → NX-EXC-001 nombrando stack y recurso', () => {
    const [v] = hygiene(evaluate(oneStack('Db-Dev', { Primary: micro('NX-COST-002') }), ctx()), 'NX-EXC-001');
    expect(v).toBeDefined();
    expect(v).toMatchObject({ severity: 'error', stack: 'Db-Dev', resource: 'Primary' });
    expect(v!.message).toContain('Db-Dev/Primary');
    expect(v!.message).toContain('NX-COST-002');
  });

  it('entrada SIN marca (obsoleta) → NX-EXC-002 nombrando el id de la entrada', () => {
    const [v] = hygiene(evaluate(oneStack('Db-Dev', { Primary: micro() }), ctx([entry({ id: 'EXC-OBS-7' })])), 'NX-EXC-002');
    expect(v).toBeDefined();
    expect(v!.resource).toBe('EXC-OBS-7');
    expect(v!.message).toContain('EXC-OBS-7');
    expect(v!.message).toMatch(/OBSOLETA/);
  });

  it('entrada VENCIDA → NX-EXC-003 nombrando el id (y la violación original reaparece)', () => {
    const res = evaluate(oneStack('Db-Dev', { Primary: micro('NX-COST-002') }), ctx([entry({ id: 'EXC-OLD-3', expires: '2026-11-17' })]));
    const [v] = hygiene(res, 'NX-EXC-003');
    expect(v).toBeDefined();
    expect(v!.message).toContain('EXC-OLD-3');
    expect(v!.message).toContain('2026-11-17');
    expect(res.filter((x) => x.ruleId === 'NX-COST-002')).toHaveLength(1);
  });

  it('marca sobre una regla que NO admite excepción → NX-EXC-004 nombrando el recurso', () => {
    const bucket = { Type: 'AWS::S3::Bucket', Properties: { Tags: [] }, Metadata: { 'nextep:exception': ['NX-FIN-001'] } };
    const [v] = hygiene(evaluate(oneStack('App-Dev', { Bucket: bucket }), ctx([entry({ guard: 'NX-FIN-001' })])), 'NX-EXC-004');
    expect(v).toBeDefined();
    expect(v!.message).toContain('App-Dev/Bucket');
    expect(v!.message).toContain('NX-FIN-001');
  });

  it('entrada sobre una regla que NO admite excepción → NX-EXC-004 nombrando el id', () => {
    const [v] = hygiene(evaluate(oneStack('App-Dev', {}), ctx([entry({ id: 'EXC-NOPE', guard: 'NX-POWER-001' })])), 'NX-EXC-004');
    expect(v).toBeDefined();
    expect(v!.message).toContain('EXC-NOPE');
  });

  it('marca y entrada de una regla que no existe: se reportan, nombrando el id desconocido', () => {
    const res = evaluate(oneStack('Db-Dev', { Primary: micro('NX-FAKE-999') }), ctx([entry({ id: 'EXC-F', guard: 'NX-FAKE-999' })]));
    expect(hygiene(res, 'NX-EXC-001')[0]?.message).toContain('NX-FAKE-999');
    expect(hygiene(res, 'NX-EXC-002')[0]?.message).toContain('EXC-F');
  });

  it('marca + entrada vigente: sin violaciones de higiene y la regla queda silenciada', () => {
    const res = evaluate(oneStack('Db-Dev', { Primary: micro('NX-COST-002') }), ctx([entry()]));
    expect(res.filter((v) => v.ruleId.startsWith('NX-EXC') || v.ruleId === 'NX-COST-002')).toEqual([]);
  });

  it('las entradas de otros guards (G4, tags-finops…) no son de este motor y se ignoran', () => {
    const res = evaluate(oneStack('Db-Dev', { Primary: micro() }), ctx([entry({ id: 'EXC-G4', guard: 'G4' }), entry({ id: 'EXC-TAGS', guard: 'tags-finops' })]));
    expect(res.filter((v) => v.ruleId.startsWith('NX-EXC'))).toEqual([]);
  });

  it('una entrada sirve a varios recursos con la misma marca (no hay que repetirla por recurso)', () => {
    const res = evaluate(oneStack('Db-Dev', { A: micro('NX-COST-002'), B: micro('NX-COST-002') }), ctx([entry()]));
    expect(res.filter((v) => v.ruleId === 'NX-COST-002' || v.ruleId.startsWith('NX-EXC'))).toEqual([]);
  });
});

describe('allowException: la mitad «código» de la excepción', () => {
  const cfnLike = () => ({ cfnOptions: {} as { metadata?: Record<string, unknown> } });

  it('escribe la marca en Metadata del recurso', () => {
    const r = cfnLike();
    allowException(r, 'NX-COST-002');
    expect(r.cfnOptions.metadata).toEqual({ 'nextep:exception': ['NX-COST-002'] });
  });

  it('acumula reglas sin duplicar y conserva el resto de Metadata', () => {
    const r = { cfnOptions: { metadata: { otra: 1, 'nextep:exception': ['NX-COST-001'] } as Record<string, unknown> } };
    allowException(r, 'NX-COST-002');
    allowException(r, 'NX-COST-002');
    expect(r.cfnOptions.metadata).toEqual({ otra: 1, 'nextep:exception': ['NX-COST-001', 'NX-COST-002'] });
  });

  it('acepta un L2 por su defaultChild', () => {
    const child = cfnLike();
    allowException({ node: { defaultChild: child } }, 'NX-COST-003');
    expect(child.cfnOptions.metadata).toEqual({ 'nextep:exception': ['NX-COST-003'] });
  });

  it('un objeto que no es L1 ni L2 con defaultChild se rechaza con un mensaje claro', () => {
    expect(() => allowException({ node: {} } as never, 'NX-COST-003')).toThrow(/CfnResource/);
  });
});

describe('parseExceptionsYaml (sin dependencias de runtime)', () => {
  const repoFile = path.resolve(__dirname, '..', 'fixtures', 'exceptions', 'sample.yml');

  it('lee un archivo de excepciones de muestra igual que el parser de YAML completo', () => {
    const text = fs.readFileSync(repoFile, 'utf8');
    const expected = (parseYaml(text) as { exceptions: ExceptionEntry[] }).exceptions;
    expect(expected.length).toBeGreaterThan(0);
    expect(parseExceptionsYaml(text)).toEqual(expected);
  });

  const BASE = 'version: 1\nexceptions:\n  - id: EXC-1\n    guard: NX-COST-002\n    reason: "Motivo suficientemente largo"\n    owner: devops\n    expires: "2027-01-01"\n';

  it('comentarios de línea y finales; un # dentro de comillas no es comentario', () => {
    const text = `# cabecera\n${BASE.replace('devops', 'devops # dueño').replace('suficientemente largo', 'con # almohadilla dentro')}`;
    const [e] = parseExceptionsYaml(text);
    expect(e).toMatchObject({ owner: 'devops', reason: 'Motivo con # almohadilla dentro' });
  });

  it('acepta comillas simples, escapes y exceptions: []', () => {
    expect(parseExceptionsYaml("version: 1\nexceptions: []\n")).toEqual([]);
    const [e] = parseExceptionsYaml(BASE.replace('"Motivo suficientemente largo"', "'No es ''tan'' corto'"));
    expect(e?.reason).toBe("No es 'tan' corto");
  });

  it.each([
    ['escalar de bloque (>)', BASE.replace('reason: "Motivo suficientemente largo"', 'reason: >\n      texto')],
    ['mapa de flujo', BASE.replace('owner: devops', 'owner: {a: b}')],
    ['ancla', BASE.replace('owner: devops', 'owner: &x devops')],
    ['campo desconocido', BASE.replace('owner: devops', 'owner: devops\n    extra: 1')],
    ['campo duplicado', BASE.replace('owner: devops', 'owner: devops\n    owner: otro')],
    ['clave de primer nivel desconocida', BASE + 'otra: 1\n'],
    ['version distinta de 1', BASE.replace('version: 1', 'version: 2')],
    ['sin version', BASE.replace('version: 1\n', '')],
    ['reason de menos de 10 caracteres', BASE.replace('Motivo suficientemente largo', 'corto')],
    ['expires que no es YYYY-MM-DD', BASE.replace('2027-01-01', '01/01/2027')],
    ['entrada sin guard', BASE.replace('    guard: NX-COST-002\n', '')],
    ['string sin cerrar', BASE.replace('"Motivo suficientemente largo"', '"sin cerrar')],
  ])('rechaza: %s', (_name, text) => {
    expect(() => parseExceptionsYaml(text)).toThrow(/exceptions\.yml/);
  });
});
