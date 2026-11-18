import { checkExceptions, parseExceptionsDoc, scanMarks, validateExceptionsDoc } from '@nextep/gates';

const TODAY = new Date('2026-11-18T00:00:00Z');
const entry = (over: Record<string, string> = {}) => ({ id: 'EXC-1', guard: 'G-1', reason: 'Motivo suficientemente largo', owner: 'platform', expires: '2027-01-01', ...over });

describe('scanMarks', () => {
  it('lee marcas con // y con #', () => {
    expect(scanMarks('a.ts', '// nextep-exception: EXC-1\nx\n# nextep-exception: EXC-2')).toEqual([
      { id: 'EXC-1', file: 'a.ts' },
      { id: 'EXC-2', file: 'a.ts' },
    ]);
  });
  it('un texto sin marcas no devuelve nada', () => {
    expect(scanMarks('a.ts', 'nextep-exception sin prefijo de comentario')).toEqual([]);
  });
});

describe('checkExceptions: cada fallo en rojo, nombrando al culpable', () => {
  it('limpio: marca + entrada vigente', () => {
    expect(checkExceptions([entry()], [{ id: 'EXC-1', file: 'a.ts' }], TODAY)).toEqual([]);
  });
  it('marca sin entrada: nombra el archivo', () => {
    expect(checkExceptions([], [{ id: 'EXC-9', file: 'src/malo.ts' }], TODAY).join('\n')).toMatch(/src\/malo\.ts: marca nextep-exception "EXC-9" sin entrada/);
  });
  it('entrada sin marca (obsoleta): nombra el id', () => {
    expect(checkExceptions([entry()], [], TODAY).join('\n')).toMatch(/entrada OBSOLETA "EXC-1"/);
  });
  it('entrada vencida: nombra el id y la fecha', () => {
    expect(checkExceptions([entry({ expires: '2026-11-17' })], [{ id: 'EXC-1', file: 'a.ts' }], TODAY).join('\n')).toMatch(/"EXC-1" VENCIO el 2026-11-17/);
  });
  it('vence el mismo dia: aun vigente', () => {
    expect(checkExceptions([entry({ expires: '2026-11-18' })], [{ id: 'EXC-1', file: 'a.ts' }], TODAY)).toEqual([]);
  });
  it('id duplicado', () => {
    expect(checkExceptions([entry(), entry()], [{ id: 'EXC-1', file: 'a.ts' }], TODAY).join('\n')).toMatch(/entrada duplicada.*EXC-1/);
  });
  it('el label aparece en los mensajes', () => {
    expect(checkExceptions([entry()], [], TODAY, 'docs/exceptions.yml').join('\n')).toMatch(/docs\/exceptions\.yml/);
  });
});

describe('parseExceptionsDoc / validateExceptionsDoc', () => {
  const OK = 'version: 1\nexceptions:\n  - id: EXC-1\n    guard: G-1\n    reason: "Motivo suficientemente largo"\n    owner: platform\n    expires: 2027-01-01\n';
  it('parsea y normaliza una fecha YAML sin comillas', () => {
    expect(parseExceptionsDoc(OK)).toEqual([entry()]);
  });
  it('exceptions vacia es valido', () => {
    expect(parseExceptionsDoc('version: 1\nexceptions: []\n')).toEqual([]);
  });
  it('version distinta de 1, falta de campos, motivo corto y fecha invalida: todos nombrados', () => {
    const bad = { version: 2, exceptions: [{ id: 'EXC-1', guard: 'G', reason: 'corto', owner: '', expires: '01/01/2027' }] };
    const out = validateExceptionsDoc(bad, 'f.yml').join('\n');
    expect(out).toMatch(/"version" debe ser 1/);
    expect(out).toMatch(/EXC-1\): falta "owner"/);
    expect(out).toMatch(/"reason" debe tener al menos 10/);
    expect(out).toMatch(/"expires" debe ser una fecha YYYY-MM-DD/);
  });
  it('un documento que no es mapa falla', () => {
    expect(() => parseExceptionsDoc('- a\n- b\n')).toThrow(/debe ser un mapa/);
  });
});
