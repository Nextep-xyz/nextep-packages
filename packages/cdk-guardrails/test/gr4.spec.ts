import { evaluate } from '@guardrails/src/engine';
import { main } from '@guardrails/src/cli';
import type { GuardrailsContext } from '@guardrails/src/types';
import { NOW, oneStack } from '@guardrails/test/helpers';

// GR4 (spec cdk-guardrails §3): no existe forma de desactivar una regla por opción. Tres puertas, las tres cerradas:
// el tipo del contexto, el motor en tiempo de ejecución y la CLI. (La cuarta, `Validations.acknowledge`, se prueba en plugin.spec.ts.)

describe('GR4: GuardrailsContext no tiene forma de desactivar una regla', () => {
  it('en el sistema de tipos: skip/disable/ignore/disabledRules no existen', () => {
    // Si alguien agrega uno de estos campos a GuardrailsContext, el @ts-expect-error deja de fallar y ts-jest rompe esta suite.
    // @ts-expect-error skip no es un campo de GuardrailsContext
    const a: GuardrailsContext = { stage: 'dev', exceptions: [], skip: ['NX-COST-001'] };
    // @ts-expect-error disable no es un campo de GuardrailsContext
    const b: GuardrailsContext = { stage: 'dev', exceptions: [], disable: ['NX-COST-001'] };
    // @ts-expect-error ignore no es un campo de GuardrailsContext
    const c: GuardrailsContext = { stage: 'dev', exceptions: [], ignore: ['NX-COST-001'] };
    expect([a, b, c]).toHaveLength(3);
  });

  it('en ejecución: el motor RECHAZA un campo extra aunque el tipo se haya saltado', () => {
    const app = oneStack('Obs-Dev', { Board: { Type: 'AWS::CloudWatch::Dashboard', Properties: {} } });
    const ctx = { stage: 'dev', exceptions: [], now: NOW, skip: ['NX-COST-001'] } as unknown as GuardrailsContext;
    expect(() => evaluate(app, ctx)).toThrow(/"skip" no permitido/);
  });

  it('en la CLI: una opción para omitir una regla es una opción desconocida (exit 2), no se ignora', () => {
    const io = { out: jest.fn(), err: jest.fn() };
    expect(main(['check', '--out', '.', '--stage', 'dev', '--skip', 'NX-COST-001'], io)).toBe(2);
    expect(io.err.mock.calls.flat().join('\n')).toMatch(/opción desconocida --skip/);
  });
});
