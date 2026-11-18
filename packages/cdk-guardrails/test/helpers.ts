import * as fs from 'fs';
import * as path from 'path';
import fg from 'fast-glob';
import type { CfnResource, GuardrailsContext, StackTemplate } from '@guardrails/src/types';

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
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'context.json'), 'utf8')) as Omit<GuardrailsContext, 'now'> & { now?: string };
  const templates = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.template.json'))
    .sort()
    .map((f) => ({ stack: f.replace(/\.template\.json$/, ''), template: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as StackTemplate['template'] }));
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
