import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discover, discoverDirs } from '@nextep/gates';

function tmp(files: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-discover-'));
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), 'x');
  }
  return dir;
}

describe('discover', () => {
  it('descubre por disco, ordena y normaliza separadores', () => {
    const cwd = tmp(['b/two.ts', 'a/one.ts', 'a/node_modules/x.ts']);
    expect(discover(['**/*.ts'], { cwd, min: 2 })).toEqual(['a/one.ts', 'b/two.ts']);
  });

  it('0 sujetos: falla nombrando los globs (un gate sin sujetos no prueba nada)', () => {
    const cwd = tmp(['a.md']);
    expect(() => discover(['**/*.ts'], { cwd, min: 1 })).toThrow(/0 sujetos.*\*\*\/\*\.ts/);
  });

  it('menos que min: falla diciendo cuantos encontro', () => {
    const cwd = tmp(['a.ts']);
    expect(() => discover(['**/*.ts'], { cwd, min: 3 })).toThrow(/1 sujetos \(menos de 3\)/);
  });

  it.each([0, -1, 1.5, Number.NaN])('min invalido (%s): falla', (min) => {
    expect(() => discover(['**/*'], { cwd: tmp(['a']), min })).toThrow(/"min" debe ser un entero >= 1/);
  });

  it('un archivo nuevo queda sujeto sin tocar el gate (el punto del descubrimiento por disco)', () => {
    const cwd = tmp(['rules/a.ts']);
    expect(discover(['rules/*.ts'], { cwd, min: 1 })).toHaveLength(1);
    fs.writeFileSync(path.join(cwd, 'rules/b.ts'), 'x');
    expect(discover(['rules/*.ts'], { cwd, min: 1 })).toHaveLength(2);
  });

  it('discoverDirs devuelve directorios unicos', () => {
    const cwd = tmp(['p/a/package.json', 'p/b/package.json', 'p/b/x/package.json']);
    expect(discoverDirs(['p/*/package.json'], { cwd, min: 2 })).toEqual(['p/a', 'p/b']);
  });
});
