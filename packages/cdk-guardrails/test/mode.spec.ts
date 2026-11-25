import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { App, Stack, Tags } from 'aws-cdk-lib';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { expectNextepCompliant } from '@guardrails/src/adapters/jest';
import { installGuardrails, NextepGuardrailsPlugin } from '@guardrails/src/adapters/plugin';
import { main } from '@guardrails/src/cli';
import { allowException } from '@guardrails/src/exceptions/allow';
import { EXC } from '@guardrails/src/exceptions/verify';
import { applyMode, MODE_ENV, resolveMode } from '@guardrails/src/mode';
import type { Violation } from '@guardrails/src/types';

// E7 (spec cumplimiento-paquetes-por-ambiente §2.7, F0): NEXTEP_GUARDRAILS_MODE en plugin, helper de Jest y CLI.
//   ausente / enforce → comportamiento de 0.2.0 · warn → error pasa a warning · cualquier otro valor → enforce + aviso (fail-closed)
//   NX-EXC-001..004 → fallan SIEMPRE, en ambos modos.

const TAGS = [{ Key: 'Application', Value: 'Core' }, { Key: 'Environment', Value: 'dev' }, { Key: 'Project', Value: 'Demo' }];
const BOARD = { Type: 'AWS::CloudWatch::Dashboard', Properties: { DashboardName: 'demo', DashboardBody: '{"widgets":[]}', Tags: TAGS } };
const QUEUE = { Type: 'AWS::SQS::Queue', Properties: { Tags: TAGS } };

/** Un cdk.out de CLI. `broken` agrega una marca de excepción SIN entrada (NX-EXC-001) además del dashboard (NX-COST-001, error). */
function tmpOut(opts: { broken?: boolean } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-mode-'));
  const queue = opts.broken ? { ...QUEUE, Metadata: { 'nextep:exception': ['NX-COST-001'] } } : QUEUE;
  fs.writeFileSync(path.join(dir, 'Obs-Dev.template.json'), JSON.stringify({ Resources: { Queue: queue, Board: BOARD } }));
  return dir;
}

function runCli(env: Record<string, string | undefined>, dir: string, extra: string[] = []): { code: number; out: string; err: string; summary: string } {
  const out: string[] = [];
  const err: string[] = [];
  const summaryFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-summary-')), 'summary.md');
  fs.writeFileSync(summaryFile, '');
  const code = main(['check', '--out', dir, '--stage', 'dev', ...extra], { out: (l) => out.push(l), err: (l) => err.push(l) }, new Date('2026-11-25T00:00:00Z'), {
    GITHUB_ACTIONS: 'false',
    GITHUB_STEP_SUMMARY: summaryFile,
    ...env,
  });
  return { code, out: out.join('\n'), err: err.join('\n'), summary: fs.readFileSync(summaryFile, 'utf8') };
}

/** Ejecuta `fn` con NEXTEP_GUARDRAILS_MODE fijada (o ausente) y captura stderr; restaura todo. */
function withMode<T>(value: string | undefined, fn: () => T): { result: T | undefined; error: Error | undefined; stderr: string } {
  const before = process.env[MODE_ENV];
  if (value === undefined) delete process.env[MODE_ENV];
  else process.env[MODE_ENV] = value;
  const spy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    try {
      return { result: fn(), error: undefined, stderr: spy.mock.calls.map((c) => String(c[0])).join('') };
    } catch (e) {
      return { result: undefined, error: e as Error, stderr: spy.mock.calls.map((c) => String(c[0])).join('') };
    }
  } finally {
    spy.mockRestore();
    if (before === undefined) delete process.env[MODE_ENV];
    else process.env[MODE_ENV] = before;
  }
}

function tag(stack: Stack): void {
  Tags.of(stack).add('Project', 'Demo');
  Tags.of(stack).add('Application', 'Core');
  Tags.of(stack).add('Environment', 'dev');
}

/** Un app con un dashboard (NX-COST-001, error). `broken` agrega la marca de excepción sin entrada (NX-EXC-001). */
function app(opts: { broken?: boolean; plugin?: boolean } = {}): App {
  const a = new App({ outdir: fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-mode-')) });
  if (opts.plugin) installGuardrails(a, { stage: 'dev' });
  const stack = new Stack(a, 'Obs-Dev');
  new cw.CfnDashboard(stack, 'Board', { dashboardName: 'demo', dashboardBody: '{"widgets":[]}' });
  const q = new sqs.CfnQueue(stack, 'Queue');
  if (opts.broken) allowException(q, 'NX-COST-001');
  tag(stack);
  return a;
}

function pluginReport(a: App): ReturnType<NextepGuardrailsPlugin['validate']> {
  const dir = a.synth().directory;
  return new NextepGuardrailsPlugin({ stage: 'dev', exceptions: [] }).validate({ templatePaths: fs.readdirSync(dir).filter((f) => f.endsWith('.template.json')).map((f) => path.join(dir, f)) });
}

// El valor de la variable → el modo efectivo y si debe avisar.
const ENFORCING: [string, string | undefined, boolean][] = [
  ['ausente', undefined, false],
  ['cadena vacía (equivale a ausente)', '', false],
  ['enforce', 'enforce', false],
  ['un valor basura', 'basura', true],
  ['`WARN` en mayúsculas (no es `warn`)', 'WARN', true],
  ['`warn ` con espacio (no es `warn`)', 'warn ', true],
];

describe('E7 · resolveMode y applyMode (unit)', () => {
  it.each(ENFORCING)('%s → enforce (aviso: %s)', (_n, value, warns) => {
    const r = resolveMode({ [MODE_ENV]: value });
    expect(r.mode).toBe('enforce');
    expect(r.invalid !== undefined).toBe(warns);
  });

  it('`warn` → warn, sin aviso', () => {
    expect(resolveMode({ [MODE_ENV]: 'warn' })).toEqual({ mode: 'warn' });
  });

  it('el aviso de un valor basura nombra la variable y el valor recibido', () => {
    expect(resolveMode({ [MODE_ENV]: 'basura' }).invalid).toMatch(/NEXTEP_GUARDRAILS_MODE.*"basura".*enforce/);
  });

  const v = (ruleId: string, severity: Violation['severity']): Violation => ({ ruleId, severity, stack: 'S', message: `[${ruleId}] S/R` });

  it('enforce devuelve las violaciones tal cual (misma referencia de contenido)', () => {
    const list = [v('NX-COST-001', 'error'), v('NX-ALM-001', 'warn')];
    expect(applyMode(list, 'enforce')).toEqual(list);
  });

  it('warn degrada error → warn y lo marca; las warn originales no se marcan', () => {
    const out = applyMode([v('NX-COST-001', 'error'), v('NX-ALM-001', 'warn')], 'warn');
    expect(out.map((x) => [x.ruleId, x.severity, x.downgraded === true])).toEqual([
      ['NX-COST-001', 'warn', true],
      ['NX-ALM-001', 'warn', false],
    ]);
  });

  it.each(Object.values(EXC))('%s (higiene de excepciones) NO se degrada en warn', (id) => {
    expect(applyMode([v(id, 'error')], 'warn')).toEqual([v(id, 'error')]);
  });

  it('los cuatro ids de higiene son NX-EXC-001..004 (si el motor suma uno, este test obliga a decidir)', () => {
    expect(Object.values(EXC).sort()).toEqual(['NX-EXC-001', 'NX-EXC-002', 'NX-EXC-003', 'NX-EXC-004']);
  });
});

describe('E7 · CLI × modo', () => {
  it.each(ENFORCING)('%s → enforce: un error sale con 1 y se reporta como ERROR', (_n, value, warns) => {
    const r = runCli({ [MODE_ENV]: value }, tmpOut());
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^ERROR \[NX-COST-001\]/m);
    expect(r.out).not.toMatch(/downgraded/);
    expect(r.out).toMatch(/1 error\(es\), 0 aviso\(s\)/);
    expect(/NEXTEP_GUARDRAILS_MODE/.test(r.err)).toBe(warns);
  });

  it('warn: el error se reporta como WARN [downgraded from error] y sale con 0', () => {
    const r = runCli({ [MODE_ENV]: 'warn' }, tmpOut());
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^WARN \[downgraded from error\] \[NX-COST-001\]/m);
    expect(r.out).toMatch(/0 error\(es\), 1 aviso\(s\)/);
    expect(r.err).toBe('');
  });

  it('warn + formato github: ::warning (nunca ::error) y la tabla del resumen lo marca como degradado', () => {
    const r = runCli({ [MODE_ENV]: 'warn' }, tmpOut(), ['--format', 'github']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^::warning title=NX-COST-001::\[downgraded from error\] /m);
    expect(r.out).not.toMatch(/::error/);
    expect(r.summary).toMatch(/NEXTEP_GUARDRAILS_MODE=warn/);
    expect(r.summary).toMatch(/\| aviso \(degradado de error\) \| `NX-COST-001` \|/);
  });

  it('enforce + formato github sigue emitiendo ::error y sin cabecera de modo en el resumen', () => {
    const r = runCli({ [MODE_ENV]: 'enforce' }, tmpOut(), ['--format', 'github']);
    expect(r.out).toMatch(/^::error title=NX-COST-001::/m);
    expect(r.summary).not.toMatch(/NEXTEP_GUARDRAILS_MODE/);
    expect(r.summary).not.toMatch(/degradado/);
  });

  it.each([
    ['enforce', 'enforce'],
    ['warn', 'warn'],
    ['basura', 'basura'],
    ['ausente', undefined],
  ])('NX-EXC-001 (marca sin entrada) sale con 1 en modo %s; el error común sí se degrada solo en warn', (_n, value) => {
    const r = runCli({ [MODE_ENV]: value }, tmpOut({ broken: true }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^ERROR \[NX-EXC-001\]/m);
    expect(/^WARN \[downgraded from error\] \[NX-COST-001\]/m.test(r.out)).toBe(value === 'warn');
  });

  it('una entrada vencida (NX-EXC-003) y una obsoleta (NX-EXC-002) también fallan en warn', () => {
    const dir = tmpOut();
    const yml = path.join(dir, 'exceptions.yml');
    fs.writeFileSync(yml, 'version: 1\nexceptions:\n  - id: EXC-OLD\n    guard: NX-COST-001\n    reason: "Dashboard de un cliente"\n    owner: devops\n    expires: "2020-01-01"\n');
    const r = runCli({ [MODE_ENV]: 'warn' }, dir, ['--exceptions', yml]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^ERROR \[NX-EXC-003\]/m);
    expect(r.out).toMatch(/^ERROR \[NX-EXC-002\]/m);
  });

  it('un uso incorrecto sigue saliendo con 2 en warn (el modo no esconde errores de uso)', () => {
    const out: string[] = [];
    const code = main(['check', '--stage', 'dev'], { out: (l) => out.push(l), err: () => undefined }, undefined, { [MODE_ENV]: 'warn' });
    expect(code).toBe(2);
  });
});

describe('E7 · helper de Jest × modo', () => {
  it.each(ENFORCING)('%s → enforce: lanza por el error', (_n, value, warns) => {
    const r = withMode(value, () => expectNextepCompliant(app(), { stage: 'dev' }));
    expect(r.error?.message).toMatch(/NX-COST-001/);
    expect(/NEXTEP_GUARDRAILS_MODE/.test(r.stderr)).toBe(warns);
  });

  it('warn: NO lanza; el error sale por stderr como degradado', () => {
    const r = withMode('warn', () => expectNextepCompliant(app(), { stage: 'dev' }));
    expect(r.error).toBeUndefined();
    expect(r.stderr).toMatch(/WARN \[downgraded from error\] \[NX-COST-001\] Obs-Dev\/Board/);
  });

  it.each([
    ['enforce', 'enforce'],
    ['warn', 'warn'],
    ['basura', 'basura'],
    ['ausente', undefined],
  ])('NX-EXC-001 lanza en modo %s', (_n, value) => {
    const r = withMode(value, () => expectNextepCompliant(app({ broken: true }), { stage: 'dev' }));
    expect(r.error?.message).toMatch(/NX-EXC-001/);
  });
});

describe('E7 · plugin × modo', () => {
  it.each(ENFORCING)('%s → enforce: success=false, severidad error y el synth aborta', (_n, value, warns) => {
    const report = withMode(value, () => pluginReport(app()));
    expect(report.result?.success).toBe(false);
    expect(report.result?.violations.map((x) => [x.ruleName, x.severity])).toEqual([['NX-COST-001', 'error']]);
    expect(/NEXTEP_GUARDRAILS_MODE/.test(report.stderr)).toBe(warns);
    expect(withMode(value, () => app({ plugin: true }).synth()).error?.message).toMatch(/NX-COST-001/);
  });

  it('warn: success=true, severidad `warning` de CDK, marcada como degradada, y el synth NO aborta', () => {
    const report = withMode('warn', () => pluginReport(app())).result;
    expect(report?.success).toBe(true);
    expect(report?.violations.map((x) => [x.ruleName, x.severity])).toEqual([['NX-COST-001', 'warning']]);
    expect(report?.violations[0]?.description).toMatch(/^\[downgraded from error\] \[NX-COST-001\] Obs-Dev\/Board/);
    expect(withMode('warn', () => app({ plugin: true }).synth()).error).toBeUndefined();
  });

  it.each([
    ['enforce', 'enforce'],
    ['warn', 'warn'],
    ['basura', 'basura'],
    ['ausente', undefined],
  ])('NX-EXC-001 aborta el synth en modo %s y el reporte lo deja como error', (_n, value) => {
    const report = withMode(value, () => pluginReport(app({ broken: true }))).result;
    expect(report?.success).toBe(false);
    expect(report?.violations.find((x) => x.ruleName === 'NX-EXC-001')?.severity).toBe('error');
    expect(withMode(value, () => app({ broken: true, plugin: true }).synth()).error?.message).toMatch(/NX-EXC-001/);
  });

  it('el modo se lee en validate() (momento del synth), no al construir el plugin', () => {
    const plugin = new NextepGuardrailsPlugin({ stage: 'dev', exceptions: [] });
    const dir = app().synth().directory;
    const paths = fs.readdirSync(dir).filter((f) => f.endsWith('.template.json')).map((f) => path.join(dir, f));
    expect(withMode('warn', () => plugin.validate({ templatePaths: paths })).result?.success).toBe(true);
    expect(withMode(undefined, () => plugin.validate({ templatePaths: paths })).result?.success).toBe(false);
  });
});
