import { evaluate } from '@guardrails/src/engine';
import type { ExceptionEntry, GuardrailsContext, Rule } from '@guardrails/src/types';
import { NOW, oneStack } from '@guardrails/test/helpers';

const ctx = (over: Partial<GuardrailsContext> = {}): GuardrailsContext => ({ stage: 'dev', exceptions: [], now: NOW, ...over });
const MICRO = { Type: 'AWS::RDS::DBInstance', Properties: { DBInstanceClass: 'db.t4g.micro' } };
const marked = (...ids: string[]) => ({ ...MICRO, Metadata: { 'nextep:exception': ids } });
const entry = (over: Partial<ExceptionEntry> = {}): ExceptionEntry => ({
  id: 'EXC-1',
  guard: 'NX-COST-002',
  reason: 'Instancia efímera de pruebas de carga',
  owner: 'devops',
  expires: '2027-01-01',
  ...over,
});
const costViolations = (res: ReturnType<typeof evaluate>) => res.filter((v) => v.ruleId === 'NX-COST-002');

describe('evaluate(): contexto', () => {
  it('sin templates devuelve []', () => {
    expect(evaluate([], ctx())).toEqual([]);
  });

  it.each([['skip'], ['disable'], ['disabledRules'], ['ignore']])('rechaza el campo "%s": no existe forma de desactivar una regla', (key) => {
    expect(() => evaluate([], { ...ctx(), [key]: ['NX-COST-001'] } as unknown as GuardrailsContext)).toThrow(/no permitido/);
  });

  it('rechaza un stage inválido o ausente, nombrando los válidos', () => {
    expect(() => evaluate([], ctx({ stage: 'qa' as never }))).toThrow(/dev.*stg.*prod.*shared/);
    expect(() => evaluate([], {} as GuardrailsContext)).toThrow(/stage/);
  });

  it('rechaza sharedStacks que no sea una lista de strings', () => {
    expect(() => evaluate([], ctx({ sharedStacks: 'Domain' as never }))).toThrow(/sharedStacks/);
  });

  it('rechaza una entrada de excepción mal formada', () => {
    expect(() => evaluate([], ctx({ exceptions: [{ guard: 'NX-COST-002' } as never] }))).toThrow(/exceptions\[0\]/);
  });
});

describe('evaluate(): aplicabilidad, severidad y orden', () => {
  const fake = (over: Partial<Rule>): Rule => ({
    id: 'NX-TST-001',
    title: 't',
    severity: 'warn',
    appliesTo: ['dev'],
    allowsException: false,
    check: (app) => app.map((s) => ({ stack: s.stack, resource: 'R', message: `[NX-TST-001] ${s.stack}/R` })),
    ...over,
  });

  it('una regla que no aplica al stage no corre', () => {
    expect(evaluate(oneStack('S', {}), ctx({ stage: 'prod' }), [fake({})])).toEqual([]);
  });

  it('la violación hereda la severidad de la regla', () => {
    expect(evaluate(oneStack('S', {}), ctx(), [fake({ severity: 'warn' })])[0]).toMatchObject({ ruleId: 'NX-TST-001', severity: 'warn', stack: 'S', resource: 'R' });
  });

  it('el resultado es determinista: ordenado por stack, recurso y regla', () => {
    const app = [...oneStack('B', {}), ...oneStack('A', {})];
    expect(evaluate(app, ctx(), [fake({})]).map((v) => v.stack)).toEqual(['A', 'B']);
  });
});

describe('evaluate(): excepciones (marca en el template + entrada vigente)', () => {
  it('sin marca ni entrada: la violación se reporta', () => {
    expect(costViolations(evaluate(oneStack('Db-Dev', { Primary: MICRO }), ctx()))).toHaveLength(1);
  });

  it('marca + entrada vigente: se silencia (la regla admite excepción)', () => {
    expect(costViolations(evaluate(oneStack('Db-Dev', { Primary: marked('NX-COST-002') }), ctx({ exceptions: [entry()] })))).toEqual([]);
  });

  it('marca SIN entrada: se sigue reportando', () => {
    expect(costViolations(evaluate(oneStack('Db-Dev', { Primary: marked('NX-COST-002') }), ctx()))).toHaveLength(1);
  });

  it('entrada SIN marca: se sigue reportando', () => {
    expect(costViolations(evaluate(oneStack('Db-Dev', { Primary: MICRO }), ctx({ exceptions: [entry()] })))).toHaveLength(1);
  });

  it('entrada vencida: se sigue reportando', () => {
    const exceptions = [entry({ expires: '2026-11-17' })];
    expect(costViolations(evaluate(oneStack('Db-Dev', { Primary: marked('NX-COST-002') }), ctx({ exceptions })))).toHaveLength(1);
  });

  it('la entrada vence al final del día de caducidad (expires = hoy sigue vigente)', () => {
    const exceptions = [entry({ expires: '2026-11-18' })];
    expect(costViolations(evaluate(oneStack('Db-Dev', { Primary: marked('NX-COST-002') }), ctx({ exceptions })))).toEqual([]);
  });

  it('marca de OTRA regla: no silencia ésta', () => {
    expect(costViolations(evaluate(oneStack('Db-Dev', { Primary: marked('NX-COST-001') }), ctx({ exceptions: [entry({ guard: 'NX-COST-001' })] })))).toHaveLength(1);
  });

  it('la marca acepta un string suelto además de una lista', () => {
    const res = { ...MICRO, Metadata: { 'nextep:exception': 'NX-COST-002' } };
    expect(costViolations(evaluate(oneStack('Db-Dev', { Primary: res }), ctx({ exceptions: [entry()] })))).toEqual([]);
  });

  it('una regla que NO admite excepción (NX-FIN-001) sigue fallando con marca + entrada vigente', () => {
    const bucket = { Type: 'AWS::S3::Bucket', Properties: { Tags: [{ Key: 'Project', Value: 'x' }] }, Metadata: { 'nextep:exception': ['NX-FIN-001'] } };
    const exceptions = [entry({ guard: 'NX-FIN-001' })];
    expect(evaluate(oneStack('App-Dev', { Bucket: bucket }), ctx({ exceptions })).filter((v) => v.ruleId === 'NX-FIN-001')).toHaveLength(1);
  });
});

describe('evaluate(): el catálogo completo corre junto', () => {
  it('un template con varias violaciones las reporta todas, cada una con su regla', () => {
    const res = evaluate(
      oneStack('Mix-Dev', {
        Board: { Type: 'AWS::CloudWatch::Dashboard', Properties: {} },
        Db: MICRO,
      }),
      ctx(),
    );
    expect(res.map((v) => v.ruleId)).toEqual(expect.arrayContaining(['NX-COST-001', 'NX-COST-002', 'NX-POWER-003']));
  });
});

describe('evaluate(): excepción por hallazgo (Finding.exceptable)', () => {
  const TST_ENTRY = entry({ guard: 'NX-TST-001' });
  const app = (): ReturnType<typeof oneStack> => oneStack('S', { R: { Type: 'AWS::SNS::Topic', Metadata: { 'nextep:exception': ['NX-TST-001'] } } });
  const fake = (allowsException: boolean, exceptable?: boolean): Rule => ({
    id: 'NX-TST-001',
    title: 't',
    severity: 'error',
    appliesTo: ['dev'],
    allowsException,
    check: (a) => a.map((s) => ({ stack: s.stack, resource: 'R', message: '[NX-TST-001] S/R', ...(exceptable === undefined ? {} : { exceptable }) })),
  });
  const own = (r: Rule): string[] => evaluate(app(), ctx({ exceptions: [TST_ENTRY] }), [r]).filter((v) => v.ruleId === 'NX-TST-001').map((v) => `${v.stack}/${v.resource}`);

  it('sin `exceptable`, manda la regla: marca + entrada vigente la silencia', () => {
    expect(own(fake(true))).toEqual([]);
  });

  it('`exceptable: false` restringe ESE hallazgo aunque la regla admita excepción (marca + entrada no lo silencian)', () => {
    expect(own(fake(true, false))).toEqual(['S/R']);
  });

  it('`exceptable: true` NO amplía: una regla que no admite excepción sigue fallando', () => {
    expect(own(fake(false, true))).toEqual(['S/R']);
  });
});
