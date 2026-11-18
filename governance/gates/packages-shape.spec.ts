import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { discover, REPO_ROOT } from '@governance/gates/_discovery';
import { binPaths, checkPackageShape, checkUniqueNames, PackageFacts, PackageManifest } from '@governance/lib/packages-shape';
import { checkPublishConfig, checkTarballContents, checkTarballLayout } from '@governance/lib/guardrails-package';

// Forma de TODO paquete de packages/* (descubierto por disco: un paquete nuevo queda sujeto con solo aparecer) y contenido de su tarball real.
// Un gate que no encuentra paquetes no prueba nada: el minimo es 2 (@nextep/cdk-guardrails y @nextep/gates).

const GOOD: PackageFacts = {
  dir: 'packages/demo',
  hasReadme: true,
  hasBuildConfig: true,
  manifest: {
    name: '@nextep/demo',
    version: '0.1.0',
    private: true,
    license: 'UNLICENSED',
    description: 'demo',
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
    engines: { node: '>=22' },
    files: ['dist', 'README.md'],
    scripts: { build: 'tsc', prepack: 'tsc' },
  },
};
const withManifest = (over: Partial<PackageManifest>): PackageFacts => ({ ...GOOD, manifest: { ...GOOD.manifest, ...over } });

describe('forma de un paquete (unit): cada guard en rojo nombrando el archivo', () => {
  it('un paquete correcto pasa', () => {
    expect(checkPackageShape(GOOD)).toEqual([]);
  });

  it.each([
    ['nombre fuera del scope', { name: 'demo' }, /"name" debe empezar por @nextep\//],
    ['el directorio no coincide con el nombre', { name: '@nextep/otro' }, /el directorio \(demo\) debe coincidir/],
    ['version flotante', { version: '^0.1.0' }, /"version" debe ser semver exacto/],
    ['sin private: true (riesgo de npm publish)', { private: undefined }, /debe declarar "private": true/],
    ['sin licencia', { license: undefined }, /falta "license"/],
    ['con publishConfig', { publishConfig: { registry: 'https://x.example.com' } }, /"publishConfig" esta prohibido/],
    ['files comodin', { files: ['.'] }, /"files" no puede ser un comodin/],
    ['sin files', { files: undefined }, /"files" debe ser una lista explicita/],
    ['sin scripts de build', { scripts: {} }, /faltan los scripts "build" y "prepack"/],
    ['dependencia hacia el workspace', { dependencies: { '@nextep/gates': 'workspace:*' } }, /un enlace local no sobrevive al tarball/],
    ['dependencia flotante', { dependencies: { yaml: '^2.0.0' } }, /version flotante/],
  ])('%s', (_n, over, expected) => {
    const out = checkPackageShape(withManifest(over as Partial<PackageManifest>)).join('\n');
    expect(out).toMatch(/packages\/demo\/package\.json/);
    expect(out).toMatch(expected);
  });

  it('sin README o sin tsconfig.build.json: falla nombrando el archivo', () => {
    expect(checkPackageShape({ ...GOOD, hasReadme: false }).join('\n')).toMatch(/packages\/demo\/README\.md: falta/);
    expect(checkPackageShape({ ...GOOD, hasBuildConfig: false }).join('\n')).toMatch(/packages\/demo\/tsconfig\.build\.json: falta/);
  });

  it('dos paquetes con el mismo nombre', () => {
    expect(checkUniqueNames([GOOD, { ...GOOD, dir: 'packages/copia' }]).join('\n')).toMatch(/packages\/copia\/package\.json: el nombre @nextep\/demo ya lo usa packages\/demo/);
  });

  it('binPaths acepta string y mapa', () => {
    expect(binPaths({ bin: 'bin/a.js' })).toEqual(['bin/a.js']);
    expect(binPaths({ bin: { a: 'bin/a.js', b: 'bin/b.js' } })).toEqual(['bin/a.js', 'bin/b.js']);
    expect(binPaths({})).toEqual([]);
  });
});

// --- Los gates: recorren el disco -------------------------------------------------------------------------------------------

const manifests = discover(['packages/*/package.json'], { min: 2 });
const facts: PackageFacts[] = manifests.map((rel) => {
  const dir = path.posix.dirname(rel);
  return {
    dir,
    manifest: JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')) as PackageManifest,
    hasReadme: fs.existsSync(path.join(REPO_ROOT, dir, 'README.md')),
    hasBuildConfig: fs.existsSync(path.join(REPO_ROOT, dir, 'tsconfig.build.json')),
  };
});

describe('forma de los paquetes (descubrimiento por disco)', () => {
  it.each(facts.map((f) => [f.dir, f] as const))('%s cumple la forma de paquete', (_dir, f) => {
    expect(checkPackageShape(f)).toEqual([]);
    expect(checkPublishConfig(f.manifest as never).filter((m) => !m.includes('"files"'))).toEqual([]);
  });

  it('los nombres son unicos', () => {
    expect(checkUniqueNames(facts)).toEqual([]);
  });
});

describe('GR8: el tarball REAL de cada paquete (npm pack --dry-run) no lleva cuentas, ARNs ni publishConfig', () => {
  jest.setTimeout(240_000);

  it.each(facts.map((f) => [f.dir, f] as const))('%s', (_dir, f) => {
    const pkgDir = path.join(REPO_ROOT, f.dir);
    const tsc = require.resolve('typescript/bin/tsc');
    const work = path.join(os.tmpdir(), `nextep-pack-${process.pid}-${path.basename(f.dir)}`);
    // El tarball se arma sobre una copia del paquete con su dist compilado: no se ensucia el arbol y se prueba lo que se publicaria.
    fs.rmSync(work, { recursive: true, force: true });
    fs.cpSync(pkgDir, work, { recursive: true, filter: (src) => !/[\\/](node_modules|dist)([\\/]|$)/.test(src) });
    const build = spawnSync(process.execPath, [tsc, '-p', path.join(pkgDir, 'tsconfig.build.json'), '--outDir', path.join(work, 'dist')], { encoding: 'utf8' });
    expect({ status: build.status, out: build.stdout + build.stderr }).toEqual({ status: 0, out: '' });

    const pack = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: work,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    expect(pack.status).toBe(0);
    const listing = JSON.parse(pack.stdout) as { files: { path: string }[] }[];
    const paths = (listing[0]?.files ?? []).map((x) => x.path);
    expect(paths.length).toBeGreaterThan(3);

    const required = ['package.json', 'README.md', 'dist/index.js', 'dist/index.d.ts', ...binPaths(f.manifest)];
    expect(checkTarballLayout(paths, required, ['src/', 'test/', 'fixtures/', 'node_modules/'])).toEqual([]);
    const contents = paths.map((p) => ({ file: `${f.dir}: ${p}`, text: fs.readFileSync(path.join(work, p), 'utf8') }));
    expect(checkTarballContents(contents)).toEqual([]);
    fs.rmSync(work, { recursive: true, force: true });
  });
});
