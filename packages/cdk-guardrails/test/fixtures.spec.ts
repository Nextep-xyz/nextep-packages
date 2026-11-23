import { evaluate } from '@guardrails/src/engine';
import { ALL_RULES } from '@guardrails/src/rules';
import { discoverFixtureDirs, loadFixture } from '@guardrails/test/helpers';

// GR2 y GR3 (spec cdk-guardrails §3). Los casos se DESCUBREN por disco (`fixtures/<regla>/<caso>/`): un fixture nuevo queda sujeto sin tocar este archivo.
//  - GR2: cada fixture `fail` produce EXACTAMENTE las violaciones esperadas, y cada una nombra el stack y el recurso.
//  - GR3: NX-POWER-001 sigue fallando en prod aunque el recurso lleve la marca nextep:exception y exista una entrada válida.

const DIRS = discoverFixtureDirs();
const kindOf = (d: string): string => d.split('/')[1] as string;
// Casos `fail` y `fail-<variante>` (p. ej. fail-unresolvable): deben fallar con exactamente lo esperado. `fail-excepted` lo juzga GR3 (la excepción no la levanta).
// Casos `pass` y `pass-<variante>`: no producen nada de su regla.
const byKind = (kind: 'fail' | 'pass'): string[] =>
  DIRS.filter((d) => kindOf(d) === kind || (kindOf(d).startsWith(`${kind}-`) && kindOf(d) !== 'fail-excepted'));

describe('fixtures: descubrimiento', () => {
  it('descubre fixtures (un gate que no encuentra sujetos no prueba nada)', () => {
    expect(byKind('fail').length).toBeGreaterThanOrEqual(18);
    expect(byKind('pass').length).toBeGreaterThanOrEqual(18);
  });

  it('todo caso se llama fail, pass o empieza por fail-/pass- (un nombre con una errata no lo corre ningún test)', () => {
    const ok = (d: string): boolean => /^(fail|pass)(-[a-z0-9-]+)?$/.test(kindOf(d)) && (kindOf(d) !== 'fail-excepted' || d.startsWith('NX-POWER-001/'));
    expect(DIRS.filter((d) => !ok(d))).toEqual([]);
  });

  it('todo directorio de fixtures pertenece a una regla del catálogo', () => {
    const ids = new Set(ALL_RULES.map((r) => r.id));
    expect(DIRS.filter((d) => !ids.has(d.split('/')[0] as string))).toEqual([]);
  });
});

describe('GR2: cada fixture que debe fallar falla nombrando stack y recurso', () => {
  it.each(byKind('fail'))('%s', (rel) => {
    const fx = loadFixture(rel);
    const own = evaluate(fx.templates, fx.context).filter((v) => v.ruleId === fx.ruleId);
    expect(own.map((v) => `${v.stack}/${v.resource}`).sort()).toEqual([...fx.expected].sort());
    expect(own.length).toBeGreaterThan(0);
    const rule = ALL_RULES.find((r) => r.id === fx.ruleId)!;
    for (const v of own) {
      expect(v.severity).toBe(rule.severity);
      expect(v.resource).toBeDefined();
      expect(v.message).toContain(fx.ruleId);
      expect(v.message).toContain(v.stack);
      expect(v.message).toContain(v.resource as string);
    }
  });
});

describe('GR2: cada fixture que debe pasar no produce violaciones de su regla', () => {
  it.each(byKind('pass'))('%s', (rel) => {
    const fx = loadFixture(rel);
    expect(evaluate(fx.templates, fx.context).filter((v) => v.ruleId === fx.ruleId)).toEqual([]);
  });
});

describe('GR3: NX-POWER-001 no admite excepción', () => {
  const rel = 'NX-POWER-001/fail-excepted';

  it('el fixture existe, lleva la marca y una entrada válida (si no, la prueba sería vacía)', () => {
    const fx = loadFixture(rel);
    const stop = fx.templates.find((t) => t.stack === 'Power-Prod')?.template.Resources?.StopDatabase;
    expect(stop?.Metadata?.['nextep:exception']).toEqual(['NX-POWER-001']);
    expect(fx.context.exceptions.map((e) => e.guard)).toEqual(['NX-POWER-001']);
    expect(new Date(fx.context.exceptions[0]!.expires).getTime()).toBeGreaterThan((fx.context.now as Date).getTime());
  });

  it('SIGUE fallando en prod: la marca + la entrada válida no la silencian', () => {
    const fx = loadFixture(rel);
    const got = evaluate(fx.templates, fx.context).filter((v) => v.ruleId === 'NX-POWER-001');
    expect(got.map((v) => `${v.stack}/${v.resource}`).sort()).toEqual([...fx.expected].sort());
    expect(got.map((v) => `${v.stack}/${v.resource}`)).toContain('Power-Prod/StopDatabase');
  });
});
