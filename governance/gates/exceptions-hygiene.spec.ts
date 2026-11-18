import * as fs from 'fs';
import * as path from 'path';
import { checkExceptions, parseExceptionsDoc, scanMarks } from '@nextep/gates';
import { discover, REPO_ROOT } from '@governance/gates/_discovery';

// Higiene de excepciones del repo: toda excepcion se declara DOS veces (marca `nextep-exception: <ID>` en el codigo + entrada con motivo,
// dueno y caducidad en docs/exceptions.yml). Falla con marca huerfana, entrada obsoleta o vencida. Hoy no hay ninguna: es el estado sano.
// Un gate que no encuentra sujetos no prueba nada: lo que se exige descubrir es el DOMINIO escaneado (codigo fuente), no las marcas.

const EXCEPTIONS_FILE = 'docs/exceptions.yml';

describe('higiene de excepciones (unit)', () => {
  const TODAY = new Date('2026-11-18T00:00:00Z');
  it('una marca sin entrada, nombrando el archivo', () => {
    const marks = scanMarks('packages/x/src/malo.ts', '// nextep-exception: EXC-9');
    expect(checkExceptions([], marks, TODAY, EXCEPTIONS_FILE).join('\n')).toMatch(/packages\/x\/src\/malo\.ts: marca nextep-exception "EXC-9"/);
  });
});

describe('higiene de excepciones (descubrimiento por disco)', () => {
  it('el archivo de excepciones existe y es valido', () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, EXCEPTIONS_FILE), 'utf8');
    expect(() => parseExceptionsDoc(text, EXCEPTIONS_FILE)).not.toThrow();
  });

  it('marcas en el codigo y entradas del archivo coinciden, y ninguna esta vencida', () => {
    const sources = discover(['packages/*/src/**/*.ts', 'governance/**/*.ts', 'scripts/**/*.sh'], { min: 20, ignore: ['**/test/**', '**/*.spec.ts', '**/fixtures/**'] });
    const marks = sources.flatMap((f) => scanMarks(f, fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')));
    const entries = parseExceptionsDoc(fs.readFileSync(path.join(REPO_ROOT, EXCEPTIONS_FILE), 'utf8'), EXCEPTIONS_FILE);
    expect(checkExceptions(entries, marks, new Date(), EXCEPTIONS_FILE)).toEqual([]);
  });
});
