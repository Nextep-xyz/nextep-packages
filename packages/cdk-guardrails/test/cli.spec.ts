import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { main } from '@guardrails/src/cli';
import { escapeCommandData, escapeCommandProperty } from '@guardrails/src/format';
import { ALL_RULES } from '@guardrails/src/rules';
import { FIXTURES_ROOT, PKG_ROOT } from '@guardrails/test/helpers';

const DASHBOARD_OUT = path.join(FIXTURES_ROOT, 'dashboard', 'cdk.out');
const ISOLATED_ENV = { ...process.env, GITHUB_ACTIONS: 'false', GITHUB_STEP_SUMMARY: '' };

// `env` explícito y vacío por defecto: en CI (GITHUB_ACTIONS=true, GITHUB_STEP_SUMMARY definido) el test NO debe cambiar de formato ni escribir en el resumen real del run.
function run(argv: string[], env: Record<string, string | undefined> = {}): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, new Date('2026-11-18T00:00:00Z'), env);
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

  it('--list-rules lista todas las reglas del catálogo con severidad, stages y si admiten excepción', () => {
    const r = run(['--list-rules']);
    expect(r.code).toBe(0);
    const ids = r.out.split('\n').map((l) => l.split(' ')[0]);
    expect(ids).toEqual(ALL_RULES.map((r) => r.id));
    expect(ids.length).toBeGreaterThanOrEqual(8);
    expect(r.out).toMatch(/NX-POWER-001 +error +stages=prod +excepción=no/);
  });
});

// La acepta­ción de F2: el artefacto COMPILADO (el que se empaqueta) funciona, no solo el código fuente con ts-jest.
describe('CLI compilada (bin/nextep-guardrails.js sobre dist/)', () => {
  jest.setTimeout(120_000);

  it('compila con tsc y el bin sale ≠ 0 nombrando el stack sobre fixtures/dashboard/cdk.out', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-build-'));
    const tsc = require.resolve('typescript/bin/tsc');
    const build = spawnSync(process.execPath, [tsc, '-p', path.join(PKG_ROOT, 'tsconfig.build.json'), '--outDir', path.join(tmp, 'dist')], { encoding: 'utf8', env: ISOLATED_ENV });
    expect({ status: build.status, out: build.stdout + build.stderr }).toEqual({ status: 0, out: '' });
    fs.mkdirSync(path.join(tmp, 'bin'));
    fs.copyFileSync(path.join(PKG_ROOT, 'bin', 'nextep-guardrails.js'), path.join(tmp, 'bin', 'nextep-guardrails.js'));

    const bin = path.join(tmp, 'bin', 'nextep-guardrails.js');
    const check = spawnSync(process.execPath, [bin, 'check', '--out', DASHBOARD_OUT, '--stage', 'dev'], { encoding: 'utf8', env: ISOLATED_ENV });
    expect(check.status).toBe(1);
    expect(check.stdout).toContain('DemoDashboard-Dev/Board');

    const list = spawnSync(process.execPath, [bin, '--list-rules'], { encoding: 'utf8', env: ISOLATED_ENV });
    expect(list.status).toBe(0);
    expect(list.stdout.split('\n').filter(Boolean)).toHaveLength(ALL_RULES.length);
  });

  it('sin dist/ el bin falla con 2 y dice cómo compilar (no un stack trace)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-nodist-'));
    fs.mkdirSync(path.join(tmp, 'bin'));
    fs.copyFileSync(path.join(PKG_ROOT, 'bin', 'nextep-guardrails.js'), path.join(tmp, 'bin', 'nextep-guardrails.js'));
    const r = spawnSync(process.execPath, [path.join(tmp, 'bin', 'nextep-guardrails.js'), '--list-rules'], { encoding: 'utf8', env: ISOLATED_ENV });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/falta dist\/.*build/);
  });
});

// ---- Avisos (warn), anotaciones de GitHub y resumen (spec guardrails-prod-readiness §4; GR-WARN, GR-GH, GR-LIST) ----------------------------------

// Un topic usado por una alarma y sin suscriptor: SOLO dispara NX-ALM-001 (aviso) en prod.
const SILENT_TOPIC = {
  Resources: {
    Topic: { Type: 'AWS::SNS::Topic', Properties: {} },
    Alarm: { Type: 'AWS::CloudWatch::Alarm', Properties: { AlarmActions: [{ Ref: 'Topic' }] } },
  },
};
const WARN_ONLY = (): string => tmpOut({ 'Obs-Prod.template.json': SILENT_TOPIC });
// El aviso de arriba más una RDS sin respaldo (NX-BKP-001, error) en prod.
const ERROR_AND_WARN = (): string =>
  tmpOut({ 'Obs-Prod.template.json': { Resources: { ...SILENT_TOPIC.Resources, Db: { Type: 'AWS::RDS::DBInstance', Properties: { DBInstanceClass: 'db.t4g.medium', Engine: 'postgres' } } } } });

describe('GR-WARN: una warn NO hace fallar el exit code (pero se ve)', () => {
  it('solo avisos → exit 0, la línea WARN nombra regla, stack y recurso y el resumen cuenta el aviso', () => {
    const r = run(['check', '--out', WARN_ONLY(), '--stage', 'prod']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/WARN\s+\[NX-ALM-001\] Obs-Prod\/Topic/);
    expect(r.out).toMatch(/0 error\(es\), 1 aviso\(s\)/);
  });

  it('errores y avisos mezclados → exit 1 (cuentan los errores, no los avisos)', () => {
    const r = run(['check', '--out', ERROR_AND_WARN(), '--stage', 'prod']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/ERROR \[NX-BKP-001\]/);
    expect(r.out).toMatch(/WARN\s+\[NX-ALM-001\]/);
  });
});

describe('GR-GH: --format github', () => {
  it('emite ::warning title=<regla>::<mensaje> para una warn y ::error … para un error', () => {
    const w = run(['check', '--out', WARN_ONLY(), '--stage', 'prod', '--format', 'github']);
    expect(w.code).toBe(0);
    expect(w.out).toMatch(/^::warning title=NX-ALM-001::\[NX-ALM-001\] Obs-Prod\/Topic/m);
    const e = run(['check', '--out', ERROR_AND_WARN(), '--stage', 'prod', '--format', 'github']);
    expect(e.code).toBe(1);
    expect(e.out).toMatch(/^::error title=NX-BKP-001::\[NX-BKP-001\] Obs-Prod\/Db/m);
    expect(e.out).toMatch(/^::warning title=NX-ALM-001::/m);
    expect(e.out).toMatch(/nextep-guardrails: \d+ error\(es\), \d+ aviso\(s\)/); // la línea resumen se conserva
  });

  it('autodetección: GITHUB_ACTIONS=true → github; sin la variable → text; --format text la desactiva', () => {
    const dir = WARN_ONLY();
    expect(run(['check', '--out', dir, '--stage', 'prod'], { GITHUB_ACTIONS: 'true' }).out).toMatch(/^::warning title=NX-ALM-001::/m);
    expect(run(['check', '--out', dir, '--stage', 'prod'], {}).out).toMatch(/^WARN /m);
    expect(run(['check', '--out', dir, '--stage', 'prod'], { GITHUB_ACTIONS: 'false' }).out).toMatch(/^WARN /m);
    expect(run(['check', '--out', dir, '--stage', 'prod', '--format', 'text'], { GITHUB_ACTIONS: 'true' }).out).toMatch(/^WARN /m);
  });

  it('un valor inválido de --format sale con 2', () => {
    const r = run(['check', '--out', WARN_ONLY(), '--stage', 'prod', '--format', 'xml']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--format debe ser text o github/);
  });

  it('un nombre de recurso con saltos de línea, % o :: NO inyecta otro comando de workflow (cada anotación es UNA línea)', () => {
    const evil = 'Bo\n::error title=pwned::x%\r';
    const dir = tmpOut({ 'Obs-Dev.template.json': { Resources: { [evil]: { Type: 'AWS::CloudWatch::Dashboard', Properties: {} } } } });
    const r = run(['check', '--out', dir, '--stage', 'dev', '--format', 'github']);
    const commandLines = r.out.split('\n').filter((l) => l.startsWith('::'));
    expect(commandLines.length).toBeGreaterThan(0);
    expect(r.out.split('\n').filter((l) => /^::error title=pwned/.test(l))).toEqual([]);
    expect(commandLines.join('\n')).toMatch(/%0A/);
    expect(commandLines.join('\n')).toMatch(/%25/);
    expect(commandLines.join('\n')).toMatch(/%0D/);
  });

  it('el título escapa : y , (delimitan las propiedades)', () => {
    expect(escapeCommandProperty('a:b,c%')).toBe('a%3Ab%2Cc%25');
    expect(escapeCommandData('a:b,c\n')).toBe('a:b,c%0A');
  });
});

describe('GR-GH: GITHUB_STEP_SUMMARY', () => {
  const summaryFile = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-summary-')), 'summary.md');

  it('anexa una tabla Markdown con avisos y errores (y cuenta cada uno), en cualquier formato', () => {
    const file = summaryFile();
    const r = run(['check', '--out', ERROR_AND_WARN(), '--stage', 'prod'], { GITHUB_STEP_SUMMARY: file });
    expect(r.code).toBe(1);
    const md = fs.readFileSync(file, 'utf8');
    expect(md).toMatch(/### nextep-guardrails · stage `prod`/);
    expect(md).toMatch(/\*\*\d+ error\(es\)\*\* y \*\*\d+ aviso\(s\)\*\*/);
    expect(md).toContain('| Severidad | Regla | Stack | Recurso | Mensaje |');
    expect(md).toMatch(/\| error \| `NX-BKP-001` \| `Obs-Prod` \| `Db` \|/);
    expect(md).toMatch(/\| aviso \| `NX-ALM-001` \| `Obs-Prod` \| `Topic` \|/);
    // los errores van antes que los avisos
    expect(md.indexOf('| error |')).toBeLessThan(md.indexOf('| aviso |'));
  });

  it('ANEXA (no pisa) lo que ya había en el archivo: otros steps escriben en el mismo resumen', () => {
    const file = summaryFile();
    fs.writeFileSync(file, '## de otro step\n');
    run(['check', '--out', WARN_ONLY(), '--stage', 'prod'], { GITHUB_STEP_SUMMARY: file });
    const md = fs.readFileSync(file, 'utf8');
    expect(md.startsWith('## de otro step\n')).toBe(true);
    expect(md).toMatch(/nextep-guardrails · stage `prod`/);
  });

  it('sin violaciones, una línea «Sin violaciones»', () => {
    const file = summaryFile();
    run(['check', '--out', tmpOut({ 'Jobs-Dev.template.json': CLEAN }), '--stage', 'dev'], { GITHUB_STEP_SUMMARY: file });
    expect(fs.readFileSync(file, 'utf8')).toMatch(/Sin violaciones\./);
  });

  it('un pipe o un salto de línea en un mensaje no rompe la tabla (se escapan)', () => {
    const dir = tmpOut({ 'Obs-Dev.template.json': { Resources: { 'A|B\nC': { Type: 'AWS::CloudWatch::Dashboard', Properties: {} } } } });
    const file = summaryFile();
    run(['check', '--out', dir, '--stage', 'dev'], { GITHUB_STEP_SUMMARY: file });
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('| error |'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('A\\|B C');
  });

  it('un archivo de resumen que no se puede escribir avisa por stderr y NO cambia el exit code', () => {
    const bad = path.join(os.tmpdir(), 'no-existe-este-directorio-guardrails', 'summary.md');
    const clean = run(['check', '--out', tmpOut({ 'Jobs-Dev.template.json': CLEAN }), '--stage', 'dev'], { GITHUB_STEP_SUMMARY: bad });
    expect(clean.code).toBe(0);
    expect(clean.err).toMatch(/aviso: no se pudo escribir GITHUB_STEP_SUMMARY/);
    expect(run(['check', '--out', DASHBOARD_OUT, '--stage', 'dev'], { GITHUB_STEP_SUMMARY: bad }).code).toBe(1);
  });

  it('GITHUB_STEP_SUMMARY vacío = sin resumen', () => {
    expect(run(['check', '--out', WARN_ONLY(), '--stage', 'prod'], { GITHUB_STEP_SUMMARY: '' }).err).toBe('');
  });
});

describe('GR-LIST: el contrato de --list-rules con la evidencia de paquetes de la plataforma', () => {
  // La plataforma lee la salida de `--list-rules` línea por línea y toma el PRIMER token como id de regla (regex de abajo, copiada de ella).
  const PLATFORM_RULE_ID = /^[A-Za-z][A-Za-z0-9]*(-[A-Za-z0-9]+)+$/;

  it('cada línea empieza por un id que la plataforma reconoce, sin líneas extra', () => {
    const lines = run(['--list-rules']).out.split('\n');
    expect(lines).toHaveLength(ALL_RULES.length);
    for (const l of lines) expect((l.split(/\s+/)[0] as string).match(PLATFORM_RULE_ID)).not.toBeNull();
  });

  it('la severidad de los avisos aparece como `warn`', () => {
    expect(run(['--list-rules']).out).toMatch(/NX-BKP-002 +warn +stages=prod/);
  });
});
