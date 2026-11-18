import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { main } from '@guardrails/src/cli';
import { FIXTURES_ROOT, PKG_ROOT } from '@guardrails/test/helpers';

const DASHBOARD_OUT = path.join(FIXTURES_ROOT, 'dashboard', 'cdk.out');

function run(argv: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, new Date('2026-11-18T00:00:00Z'));
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function tmpOut(files: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-cli-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(content));
  return dir;
}
const TAGS = [{ Key: 'Application', Value: 'Core' }, { Key: 'Environment', Value: 'dev' }, { Key: 'Project', Value: 'Demo' }];
const CLEAN = { Resources: { Queue: { Type: 'AWS::SQS::Queue', Properties: { Tags: TAGS } } } };

// GR9 (spec cdk-guardrails §3): la CLI evalúa el cdk.out REAL. Un proyecto SIN plugin ni helper, con un Dashboard, falla en la CLI.
describe('GR9: la CLI sobre un cdk.out sin plugin ni helper', () => {
  it('el fixture es un synth real (manifest.json de CDK) de un proyecto sin guardarrailes', () => {
    expect(fs.existsSync(path.join(DASHBOARD_OUT, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(DASHBOARD_OUT, 'DemoDashboard-Dev.template.json'))).toBe(true);
    expect(fs.readFileSync(path.join(DASHBOARD_OUT, 'manifest.json'), 'utf8')).not.toMatch(/NextepGuardrails/);
  });

  it('un Dashboard hace salir la CLI con código 1, nombrando regla, stack y recurso', () => {
    const r = run(['check', '--out', DASHBOARD_OUT, '--stage', 'dev']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/NX-COST-001/);
    expect(r.out).toContain('DemoDashboard-Dev/Board');
    expect(r.out).toMatch(/1 error\(es\)/);
  });
});

describe('CLI: códigos de salida', () => {
  it('un cdk.out conforme sale con 0', () => {
    const r = run(['check', '--out', tmpOut({ 'Jobs-Dev.template.json': CLEAN }), '--stage', 'dev']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/0 error\(es\)/);
  });

  it('--shared-stacks declara los stacks sin ambiente (si no, Environment=shared en dev falla)', () => {
    const shared = { Resources: { Repo: { Type: 'AWS::ECR::Repository', Properties: { Tags: TAGS.map((t) => (t.Key === 'Environment' ? { ...t, Value: 'shared' } : t)) } } } };
    const dir = tmpOut({ 'Shared.template.json': shared });
    expect(run(['check', '--out', dir, '--stage', 'dev']).code).toBe(1);
    expect(run(['check', '--out', dir, '--stage', 'dev', '--shared-stacks', 'Shared']).code).toBe(0);
  });

  it('--exceptions: marca + entrada vigente → 0; sin la entrada → 1', () => {
    const marked = { Resources: { Db: { Type: 'AWS::RDS::DBInstance', Properties: { DBInstanceClass: 'db.t4g.micro', Tags: TAGS }, Metadata: { 'nextep:exception': ['NX-COST-002'] } } } };
    const dir = tmpOut({ 'Db-Dev.template.json': marked });
    const yml = path.join(dir, 'exceptions.yml');
    fs.writeFileSync(yml, 'version: 1\nexceptions:\n  - id: EXC-DB\n    guard: NX-COST-002\n    reason: "Instancia de pruebas de carga"\n    owner: devops\n    expires: "2027-01-01"\n');
    expect(run(['check', '--out', dir, '--stage', 'dev', '--exceptions', yml]).code).toBe(1); // NX-POWER-003: la RDS no tiene schedules; la excepción es solo de COST-002
    const only002 = run(['check', '--out', dir, '--stage', 'dev', '--exceptions', yml]);
    expect(only002.out).not.toMatch(/NX-COST-002/);
    expect(run(['check', '--out', dir, '--stage', 'dev']).out).toMatch(/NX-COST-002/);
  });

  it.each([
    ['falta --out', ['check', '--stage', 'dev'], /falta --out/],
    ['falta --stage', ['check', '--out', DASHBOARD_OUT], /--stage debe ser/],
    ['stage inválido', ['check', '--out', DASHBOARD_OUT, '--stage', 'qa'], /--stage debe ser/],
    ['comando desconocido', ['verify'], /comando desconocido/],
    ['directorio inexistente', ['check', '--out', '/no/existe', '--stage', 'dev'], /no existe/],
    ['archivo de excepciones inexistente', ['check', '--out', DASHBOARD_OUT, '--stage', 'dev', '--exceptions', '/no/existe.yml'], /no existe/],
    ['opción sin valor', ['check', '--out'], /falta el valor/],
  ])('uso incorrecto o imposible de evaluar (%s) sale con 2', (_n, argv, msg) => {
    const r = run(argv as string[]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(msg as RegExp);
  });

  it('un cdk.out sin templates sale con 2: un gate que no encuentra sujetos no prueba nada', () => {
    const r = run(['check', '--out', fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-empty-')), '--stage', 'dev']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/no contiene ningún/);
  });

  it('un cdk.out con assemblies anidados sale con 2 en vez de pasar sin haberlos leído', () => {
    const dir = tmpOut({ 'Jobs-Dev.template.json': CLEAN });
    fs.mkdirSync(path.join(dir, 'assembly-Pipeline'));
    const r = run(['check', '--out', dir, '--stage', 'dev']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/assemblies anidados \(assembly-Pipeline\)/);
  });

  it('--list-rules lista las 8 reglas con severidad, stages y si admiten excepción', () => {
    const r = run(['--list-rules']);
    expect(r.code).toBe(0);
    const ids = r.out.split('\n').map((l) => l.split(' ')[0]);
    expect(ids).toEqual(['NX-FIN-001', 'NX-COST-001', 'NX-COST-002', 'NX-COST-003', 'NX-POWER-001', 'NX-POWER-002', 'NX-POWER-003', 'NX-POWER-004']);
    expect(r.out).toMatch(/NX-POWER-001 +error +stages=prod +excepción=no/);
  });
});

// La acepta­ción de F2: el artefacto COMPILADO (el que se empaqueta) funciona, no solo el código fuente con ts-jest.
describe('CLI compilada (bin/nextep-guardrails.js sobre dist/)', () => {
  jest.setTimeout(120_000);

  it('compila con tsc y el bin sale ≠ 0 nombrando el stack sobre fixtures/dashboard/cdk.out', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-build-'));
    const tsc = require.resolve('typescript/bin/tsc');
    const build = spawnSync(process.execPath, [tsc, '-p', path.join(PKG_ROOT, 'tsconfig.build.json'), '--outDir', path.join(tmp, 'dist')], { encoding: 'utf8' });
    expect({ status: build.status, out: build.stdout + build.stderr }).toEqual({ status: 0, out: '' });
    fs.mkdirSync(path.join(tmp, 'bin'));
    fs.copyFileSync(path.join(PKG_ROOT, 'bin', 'nextep-guardrails.js'), path.join(tmp, 'bin', 'nextep-guardrails.js'));

    const bin = path.join(tmp, 'bin', 'nextep-guardrails.js');
    const check = spawnSync(process.execPath, [bin, 'check', '--out', DASHBOARD_OUT, '--stage', 'dev'], { encoding: 'utf8' });
    expect(check.status).toBe(1);
    expect(check.stdout).toContain('DemoDashboard-Dev/Board');

    const list = spawnSync(process.execPath, [bin, '--list-rules'], { encoding: 'utf8' });
    expect(list.status).toBe(0);
    expect(list.stdout.split('\n').filter(Boolean)).toHaveLength(8);
  });

  it('sin dist/ el bin falla con 2 y dice cómo compilar (no un stack trace)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-nodist-'));
    fs.mkdirSync(path.join(tmp, 'bin'));
    fs.copyFileSync(path.join(PKG_ROOT, 'bin', 'nextep-guardrails.js'), path.join(tmp, 'bin', 'nextep-guardrails.js'));
    const r = spawnSync(process.execPath, [path.join(tmp, 'bin', 'nextep-guardrails.js'), '--list-rules'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/falta dist\/.*build/);
  });
});
