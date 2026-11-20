import * as fs from 'fs';
import * as path from 'path';
import { discover, REPO_ROOT } from '@governance/gates/_discovery';
import { PKG_ROOT } from './helpers';

// L9: aws-cdk-lib y constructs SOLO como peerDependencies; cero dependencies de runtime (dos copias de aws-cdk-lib rompen `instanceof` en
// silencio). Es la version "del paquete" de lo que G-PKG exige a todos: aqui se juzga ESTE manifiesto, descubierto por disco.

interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

const PEERS = ['aws-cdk-lib', 'constructs'];

export function checkL9(m: Manifest): string[] {
  const out: string[] = [];
  const deps = Object.keys(m.dependencies ?? {});
  if (deps.length) out.push(`package.json: "dependencies" debe estar vacio (cero dependencias de runtime); tiene [${deps.join(', ')}]`);
  const opt = Object.keys(m.optionalDependencies ?? {});
  if (opt.length) out.push(`package.json: "optionalDependencies" debe estar vacio; tiene [${opt.join(', ')}]`);
  for (const peer of PEERS) {
    if (!m.peerDependencies?.[peer]) out.push(`package.json: ${peer} debe declararse en "peerDependencies"`);
    if (m.dependencies?.[peer] || m.optionalDependencies?.[peer]) out.push(`package.json: ${peer} NO puede ir en "dependencies" (solo peerDependencies)`);
    // Opcionales en `peerDependenciesMeta`: pnpm NO los auto-instala. Sin esto, el gate G-INT (que instala el tarball contra un registry muerto)
    // no puede instalar el paquete; un consumidor real ya tiene su copia de aws-cdk-lib y constructs.
    if (m.peerDependencies?.[peer] && !m.peerDependenciesMeta?.[peer]?.optional) out.push(`package.json: ${peer} debe ser un peer opcional en "peerDependenciesMeta" (si no, pnpm lo auto-instala y G-INT no puede instalar el tarball sin registry)`);
  }
  return out;
}

describe('L9 (unit): cada incumplimiento en rojo nombrando el campo', () => {
  const GOOD: Manifest = {
    peerDependencies: { 'aws-cdk-lib': '>=2.275.0 <3', constructs: '^10.0.0' },
    peerDependenciesMeta: { 'aws-cdk-lib': { optional: true }, constructs: { optional: true } },
  };

  it('un manifiesto correcto pasa', () => {
    expect(checkL9(GOOD)).toEqual([]);
  });

  it.each([
    ['aws-cdk-lib en dependencies', { ...GOOD, dependencies: { 'aws-cdk-lib': '2.275.0' } }, /"dependencies" debe estar vacio[\s\S]*aws-cdk-lib NO puede ir en "dependencies"/],
    ['una dependencia de runtime cualquiera', { ...GOOD, dependencies: { yaml: '2.9.1' } }, /"dependencies" debe estar vacio .*\[yaml\]/],
    ['constructs en optionalDependencies', { ...GOOD, optionalDependencies: { constructs: '10.8.1' } }, /constructs NO puede ir en "dependencies"/],
    ['sin el peer constructs', { ...GOOD, peerDependencies: { 'aws-cdk-lib': '>=2.275.0 <3' } }, /constructs debe declararse en "peerDependencies"/],
    ['sin peers', {}, /aws-cdk-lib debe declararse en "peerDependencies"/],
    ['un peer que pnpm auto-instalaria (no opcional)', { ...GOOD, peerDependenciesMeta: { 'aws-cdk-lib': { optional: true } } }, /constructs debe ser un peer opcional/],
  ])('%s', (_n, manifest, expected) => {
    expect(checkL9(manifest as Manifest).join('\n')).toMatch(expected);
  });
});

describe('L9 (descubrimiento por disco): el manifiesto real del paquete', () => {
  it('el paquete se descubre por disco (un gate sin sujetos no prueba nada)', () => {
    const found = discover(['packages/ecs-private-service/package.json'], { min: 1 });
    expect(found).toEqual(['packages/ecs-private-service/package.json']);
    expect(path.resolve(REPO_ROOT, found[0]!)).toBe(path.join(PKG_ROOT, 'package.json'));
  });

  it('cumple L9', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')) as Manifest;
    expect(manifest.name).toBe('@nextep/ecs-private-service');
    expect(checkL9(manifest)).toEqual([]);
  });

  it('el codigo compilado no importa nada fuera de aws-cdk-lib, constructs y sus propios archivos', () => {
    const files = discover(['packages/ecs-private-service/src/**/*.ts'], { min: 3 });
    const bad: string[] = [];
    for (const rel of files) {
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      for (const m of text.matchAll(/from\s+'([^']+)'/g)) {
        const spec = m[1]!;
        if (!(spec === 'constructs' || spec === 'aws-cdk-lib' || spec.startsWith('aws-cdk-lib/') || spec.startsWith('./'))) bad.push(`${rel}: import de "${spec}"`);
      }
    }
    expect(bad).toEqual([]);
  });
});
