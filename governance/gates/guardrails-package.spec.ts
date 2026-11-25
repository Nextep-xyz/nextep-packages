import * as fs from 'fs';
import * as path from 'path';
import { discover, REPO_ROOT } from '@governance/gates/_discovery';
import {
  checkManifest,
  checkModeWiring,
  checkPublishConfig,
  checkSourceHygiene,
  checkTarballContents,
  checkTarballLayout,
  PackageJson,
} from '@governance/lib/guardrails-package';

// GR6 y GR7 sobre @nextep/cdk-guardrails (y la logica unitaria de GR8):
//   GR6: el motor no usa red ni eval/Function ni procesos hijos; el paquete no declara dependencies de runtime.
//   GR7: aws-cdk-lib y constructs solo como peerDependencies.
//   GR8: el tarball de CADA paquete no contiene IDs de cuenta, ARNs con cuenta ni publishConfig. El gate sobre el tarball real, por
//        disco y para todos los paquetes, vive en packages-shape.spec.ts.
// (GR4, GR5 y GR9 viven en packages/cdk-guardrails/test/.)

// Valores armados en tiempo de ejecucion: este archivo es parte de un repo publico y lo escanea el propio gate G13.
const ACCOUNT = '1'.repeat(12);

const PKG = 'packages/cdk-guardrails';
const GOOD: PackageJson = {
  name: '@nextep/cdk-guardrails',
  peerDependencies: { 'aws-cdk-lib': '>=2.275.0 <3', constructs: '^10.0.0' },
  files: ['dist', 'bin', 'README.md'],
};

describe('GR6: la lógica (unit)', () => {
  it('código limpio pasa', () => {
    expect(checkSourceHygiene([{ file: 'a.ts', text: "import * as fs from 'fs';\nexport const x = 1;" }])).toEqual([]);
  });

  it('sin archivos: falla (un gate sin sujetos no prueba nada)', () => {
    expect(checkSourceHygiene([]).join('\n')).toMatch(/ningún archivo/);
  });

  it.each([
    ["import * as https from 'https';", /módulo de red/],
    ["const cp = require('node:child_process');", /módulo de red/],
    ["import http from 'http'", /módulo de red/],
    ["await fetch('x')", /fetch\(\)/],
    ['eval(code)', /eval\(\)/],
    ['const f = new Function("return 1")', /Function\(\)/],
    ["const m = await import('x')", /import\(\) dinámico/],
    ['new WebSocket(u)', /XMLHttpRequest\/WebSocket/],
  ])('%s → falla nombrando el archivo', (text, msg) => {
    const out = checkSourceHygiene([{ file: 'packages/cdk-guardrails/src/malo.ts', text }]).join('\n');
    expect(out).toMatch(/packages\/cdk-guardrails\/src\/malo\.ts: usa/);
    expect(out).toMatch(msg);
  });

  it('una mención en un comentario no cuenta; el mismo texto en código sí', () => {
    expect(checkSourceHygiene([{ file: 'a.ts', text: "// no usa fetch( ni eval( ni require('http')\n/* eval(x) */\nconst a = 1;" }])).toEqual([]);
    expect(checkSourceHygiene([{ file: 'a.ts', text: 'const a = 1; eval(a)' }]).length).toBeGreaterThan(0);
  });

  it('un archivo aislado a propósito (preflight, F6) queda exento, solo él', () => {
    const files = [
      { file: 'src/preflight.ts', text: "import https from 'https'" },
      { file: 'src/otro.ts', text: "import https from 'https'" },
    ];
    expect(checkSourceHygiene(files, ['src/preflight.ts']).join('\n')).toMatch(/src\/otro\.ts/);
    expect(checkSourceHygiene(files, ['src/preflight.ts']).join('\n')).not.toMatch(/preflight/);
  });
});

describe('GR6/GR7: el manifiesto (unit)', () => {
  it('un manifiesto correcto pasa', () => {
    expect(checkManifest(GOOD)).toEqual([]);
  });

  it('dependencies con algo: falla nombrando qué', () => {
    expect(checkManifest({ ...GOOD, dependencies: { yaml: '2.0.0' } }).join('\n')).toMatch(/"dependencies" debe estar vacío.*yaml/);
  });

  it('aws-cdk-lib en dependencies: falla (dos copias rompen instanceof)', () => {
    const out = checkManifest({ ...GOOD, dependencies: { 'aws-cdk-lib': '2.275.0' } }).join('\n');
    expect(out).toMatch(/aws-cdk-lib NO puede ir en "dependencies"/);
  });

  it.each(['aws-cdk-lib', 'constructs'])('sin %s en peerDependencies: falla', (peer) => {
    const peers = { ...GOOD.peerDependencies };
    delete peers[peer];
    expect(checkManifest({ ...GOOD, peerDependencies: peers }).join('\n')).toMatch(new RegExp(`${peer} debe declararse en "peerDependencies"`));
  });
});

describe('GR8: la lógica (unit)', () => {
  it('un tarball limpio pasa', () => {
    expect(checkTarballContents([{ file: 'dist/a.js', text: 'module.exports = {}; // arn:aws:scheduler:::aws-sdk:rds:stopDBInstance' }])).toEqual([]);
  });

  it.each([
    ['un ID de cuenta', `const a = "${ACCOUNT}";`, /ID de cuenta/],
    ['un ARN con cuenta', `arn:aws:iam::${ACCOUNT}:role/x`, /ARN con cuenta/],
    ['un endpoint de AWS', `https://d-${ACCOUNT}.example.us-east-2.amazonaws.com/npm/x/`, /endpoint de AWS/],
    ['publishConfig', '"publishConfig": {}', /publishConfig/],
  ])('%s → falla nombrando el archivo', (_n, text, msg) => {
    const out = checkTarballContents([{ file: 'dist/malo.js', text }]).join('\n');
    expect(out).toMatch(/dist\/malo\.js: contiene/);
    expect(out).toMatch(msg);
  });

  it('un tarball sin archivos falla', () => {
    expect(checkTarballContents([]).join('\n')).toMatch(/no tiene archivos/);
  });

  it('publishConfig.registry en el manifiesto falla; sin files explícito, también', () => {
    expect(checkPublishConfig({ ...GOOD, publishConfig: { registry: 'https://registry.example.com' } }).join('\n')).toMatch(/publishConfig\.registry está prohibido/);
    expect(checkPublishConfig({ ...GOOD, files: undefined }).join('\n')).toMatch(/"files" debe ser una lista explícita/);
    expect(checkPublishConfig({ ...GOOD, files: ['*'] }).join('\n')).toMatch(/comodín/);
    expect(checkPublishConfig(GOOD)).toEqual([]);
    expect(checkPublishConfig({ ...GOOD, publishConfig: { access: 'restricted' } })).toEqual([]);
  });

  it('el layout exige lo del consumidor y excluye lo del monorepo', () => {
    const out = checkTarballLayout(['package.json', 'src/engine.ts', 'fixtures/x.json'], ['dist/index.js', 'bin/nextep-guardrails.js'], ['src/', 'fixtures/', 'test/']).join('\n');
    expect(out).toMatch(/no incluye dist\/index\.js/);
    expect(out).toMatch(/incluye src\/engine\.ts/);
    expect(out).toMatch(/incluye fixtures\/x\.json/);
  });
});

describe('GR-MODE: la lógica (unit)', () => {
  const wired = { file: 'src/adapters/ok.ts', text: 'const v = applyEnvMode(evaluate(t, c), process.env, w);' };

  it('un adaptador que pasa por el modo pasa; el motor (define evaluate) queda fuera', () => {
    const engine = { file: 'src/engine.ts', text: 'export function evaluate(a, b) { return []; }' };
    expect(checkModeWiring([wired, engine])).toEqual([]);
  });

  it('un adaptador que evalúa sin modo falla nombrando el archivo', () => {
    const out = checkModeWiring([wired, { file: 'src/adapters/nuevo.ts', text: 'const v = evaluate(t, c);' }]).join('\n');
    expect(out).toMatch(/src\/adapters\/nuevo\.ts: llama a evaluate\(\) sin pasar por applyMode/);
    expect(out).not.toMatch(/ok\.ts/);
  });

  it('una mención de applyMode en un comentario no cuenta', () => {
    expect(checkModeWiring([{ file: 'src/a.ts', text: '// applyMode(x)\nconst v = evaluate(t, c);' }]).join('\n')).toMatch(/src\/a\.ts/);
  });

  it('sin ningún llamador falla (un gate sin sujetos no prueba nada)', () => {
    expect(checkModeWiring([]).join('\n')).toMatch(/ningún archivo/);
  });
});

// --- Los gates: recorren el disco / el tarball real -------------------------------------------------------------------------

const readJson = (rel: string): PackageJson => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')) as PackageJson;

describe('GR6/GR7: el gate (descubrimiento por disco)', () => {
  it('src/**/*.ts del paquete no usa red, procesos hijos ni evaluación dinámica', () => {
    const files = discover([`${PKG}/src/**/*.ts`], { min: 10 }).map((file) => ({ file, text: fs.readFileSync(path.join(REPO_ROOT, file), 'utf8') }));
    expect(checkSourceHygiene(files)).toEqual([]);
  });

  it('GR-MODE: todo archivo de src/ que llama al motor pasa su resultado por el modo (NEXTEP_GUARDRAILS_MODE)', () => {
    const files = discover([`${PKG}/src/**/*.ts`], { min: 10 }).map((file) => ({ file, text: fs.readFileSync(path.join(REPO_ROOT, file), 'utf8') }));
    expect(checkModeWiring(files)).toEqual([]);
  });

  it('package.json: cero dependencies de runtime y aws-cdk-lib/constructs solo como peerDependencies', () => {
    expect(checkManifest(readJson(`${PKG}/package.json`))).toEqual([]);
  });
});

