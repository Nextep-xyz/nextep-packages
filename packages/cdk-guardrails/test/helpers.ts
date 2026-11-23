import * as fs from 'fs';
import * as path from 'path';
import fg from 'fast-glob';
import { evaluate } from '@guardrails/src/engine';
import type { CfnResource, ExceptionEntry, GuardrailsContext, StackMeta, StackTemplate, Stage, Violation } from '@guardrails/src/types';

export const PKG_ROOT = path.resolve(__dirname, '..');
export const FIXTURES_ROOT = path.join(PKG_ROOT, 'fixtures');

export interface Fixture {
  ruleId: string;
  kind: string;
  dir: string;
  templates: StackTemplate[];
  context: GuardrailsContext;
  expected: string[];
}

/** Descubre por disco TODOS los directorios de fixtures `fixtures/<ruleId>/<caso>/` (un caso = un directorio con context.json). */
export function discoverFixtureDirs(): string[] {
  return fg
    .sync('*/*/context.json', { cwd: FIXTURES_ROOT, onlyFiles: true })
    .map((f) => path.posix.dirname(f))
    .sort();
}

export function loadFixture(rel: string): Fixture {
  const dir = path.join(FIXTURES_ROOT, rel);
  const [ruleId, kind] = rel.split('/') as [string, string];
  // `meta` (opcional) = lo que en un cdk.out real viene de manifest.json: { "<stack>": { region, terminationProtection } }. No es parte del contexto del motor.
  const { meta, ...raw } = JSON.parse(fs.readFileSync(path.join(dir, 'context.json'), 'utf8')) as Omit<GuardrailsContext, 'now'> & { now?: string; meta?: Record<string, StackMeta> };
  const templates = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.template.json'))
    .sort()
    .map((f): StackTemplate => {
      const stack = f.replace(/\.template\.json$/, '');
      const m = meta?.[stack];
      return { stack, template: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as StackTemplate['template'], ...(m ? { meta: m } : {}) };
    });
  const expectedFile = path.join(dir, 'expected.json');
  const expected = fs.existsSync(expectedFile) ? (JSON.parse(fs.readFileSync(expectedFile, 'utf8')) as string[]) : [];
  return { ruleId, kind, dir, templates, context: { ...raw, now: raw.now ? new Date(raw.now) : undefined } as GuardrailsContext, expected };
}

/** Atajo para construir una app de un solo stack en los tests de bordes. */
export function oneStack(stack: string, resources: Record<string, CfnResource>): StackTemplate[] {
  return [{ stack, template: { Resources: resources } }];
}

export const TAGS_DEV = [
  { Key: 'Application', Value: 'Core' },
  { Key: 'Environment', Value: 'dev' },
  { Key: 'Project', Value: 'Demo' },
];

export const universalArn = (action: string): unknown => ({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':scheduler:::aws-sdk:' + action]] });

export const schedule = (expr: string, action: string, state = 'ENABLED'): CfnResource => ({
  Type: 'AWS::Scheduler::Schedule',
  Properties: { ScheduleExpression: expr, State: state, Target: { Arn: universalArn(action) } },
});

export const NOW = new Date('2026-11-18T00:00:00Z');

// --- Helpers de los tests de reglas de «preparación para producción» (rules-*.spec.ts) --------------------------------------------------

export const evalAll = (app: StackTemplate[], stage: Stage, over: Partial<GuardrailsContext> = {}): Violation[] => evaluate(app, { stage, exceptions: [], now: NOW, ...over });
/** `stack/recurso` de cada violación de UNA regla, en el orden determinista del motor. */
export const run = (app: StackTemplate[], stage: Stage, ruleId: string, over: Partial<GuardrailsContext> = {}): string[] =>
  evalAll(app, stage, over)
    .filter((v) => v.ruleId === ruleId)
    .map((v) => `${v.stack}/${v.resource}`);
/** Mensajes de UNA regla, unidos con saltos de línea. */
export const msgs = (app: StackTemplate[], stage: Stage, ruleId: string, over: Partial<GuardrailsContext> = {}): string =>
  evalAll(app, stage, over)
    .filter((v) => v.ruleId === ruleId)
    .map((v) => v.message)
    .join('\n');
export const R = (Type: string, Properties: Record<string, unknown> = {}, extra: Partial<CfnResource> = {}): CfnResource => ({ Type, Properties, ...extra });
export const stack = (name: string, Resources: Record<string, CfnResource>, extra: Partial<StackTemplate['template']> = {}, meta?: StackMeta): StackTemplate => ({
  stack: name,
  template: { Resources, ...extra },
  ...(meta ? { meta } : {}),
});
export const entry = (guard: string, over: Partial<ExceptionEntry> = {}): ExceptionEntry => ({ id: `EXC-${guard}`, guard, reason: 'Excepción de prueba con motivo', owner: 'devops', expires: '2027-01-01', ...over });
export const marked = (res: CfnResource, ...ids: string[]): CfnResource => ({ ...res, Metadata: { 'nextep:exception': ids } });
