import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { App, CfnResource, Stack, Tags, Validations } from 'aws-cdk-lib';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { expectNextepCompliant } from '@guardrails/src/adapters/jest';
import { installGuardrails, NextepGuardrailsPlugin, PLUGIN_NAME } from '@guardrails/src/adapters/plugin';
import { allowException } from '@guardrails/src/exceptions/allow';
import type { ExceptionEntry } from '@guardrails/src/types';

// El plugin y el helper de Jest contra un App de CDK REAL (aws-cdk-lib es devDependency del paquete; en los proyectos es peer).

function tagged(stack: Stack, env = 'dev'): void {
  Tags.of(stack).add('Project', 'Demo');
  Tags.of(stack).add('Application', 'Core');
  Tags.of(stack).add('Environment', env);
}

/** Un app con un dashboard de CloudWatch (viola NX-COST-001) en el stack `Obs-Dev`. */
function appWithDashboard(opts: { plugin?: boolean; beta1?: boolean; ack?: boolean; excepted?: boolean } = {}): App {
  const plugin = new NextepGuardrailsPlugin({ stage: 'dev', exceptions: [] });
  const app = new App({ outdir: fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-')), ...(opts.beta1 ? { policyValidationBeta1: [plugin] } : {}) });
  if (opts.plugin) installGuardrails(app, { stage: 'dev' });
  const stack = new Stack(app, 'Obs-Dev');
  const board = new cw.CfnDashboard(stack, 'Board', { dashboardName: 'demo', dashboardBody: '{"widgets":[]}' });
  tagged(stack);
  if (opts.ack) Validations.of(app).acknowledge({ id: `${PLUGIN_NAME}::NX-COST-001`, reason: 'intento de silenciar' });
  if (opts.excepted) allowException(board, 'NX-COST-001');
  return app;
}

function cleanApp(opts: { plugin?: boolean } = {}): App {
  const app = new App({ outdir: fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-')) });
  if (opts.plugin) installGuardrails(app, { stage: 'dev' });
  const stack = new Stack(app, 'Jobs-Dev');
  new sqs.Queue(stack, 'Queue');
  tagged(stack);
  return app;
}

const ENTRY: ExceptionEntry = { id: 'EXC-DASH', guard: 'NX-COST-001', reason: 'Dashboard exigido por un cliente', owner: 'devops', expires: '2099-01-01' };

describe('adaptador 1: el plugin aborta el synth (Validations.of(app).addPlugins)', () => {
  it('un app conforme sintetiza', () => {
    expect(() => cleanApp({ plugin: true }).synth()).not.toThrow();
  });

  it('un app con un Dashboard ABORTA el synth y el error nombra regla, stack y recurso', () => {
    expect(() => appWithDashboard({ plugin: true }).synth()).toThrow(/NX-COST-001[\s\S]*Obs-Dev\/Board|Obs-Dev\/Board[\s\S]*NX-COST-001/);
  });

  it('el camino deprecado (policyValidationBeta1) también aborta con el mismo plugin', () => {
    expect(() => appWithDashboard({ beta1: true }).synth()).toThrow(/Obs-Dev\/Board/);
  });

  it('Validations.acknowledge NO silencia al plugin: el synth falla diciendo que no se puede (GR4, bypass de spikes S1-B)', () => {
    expect(() => appWithDashboard({ plugin: true, ack: true }).synth()).toThrow(/acknowledge no puede silenciar.*NextepGuardrails::NX-COST-001/);
  });

  it('allowException + entrada vigente silencia la violación (la única forma de excepción)', () => {
    const app = new App({ outdir: fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-')) });
    installGuardrails(app, { stage: 'dev', exceptions: [ENTRY] });
    const stack = new Stack(app, 'Obs-Dev');
    const board = new cw.CfnDashboard(stack, 'Board', { dashboardName: 'demo', dashboardBody: '{"widgets":[]}' });
    tagged(stack);
    allowException(board as CfnResource, 'NX-COST-001');
    expect(() => app.synth()).not.toThrow();
  });

  it('la marca sin entrada hace fallar el synth (NX-EXC-001), no se silencia sola', () => {
    expect(() => appWithDashboard({ plugin: true, excepted: true }).synth()).toThrow(/NX-EXC-001|sin entrada/);
  });

  it('un archivo de excepciones inexistente falla al construir el plugin (no equivale a «sin excepciones»)', () => {
    expect(() => new NextepGuardrailsPlugin({ stage: 'dev', exceptionsFile: '/no/existe/exceptions.yml' })).toThrow(/no existe/);
  });

  it('el plugin declara su nombre y los ids de todas las reglas (analítica de CDK)', () => {
    const p = new NextepGuardrailsPlugin({ stage: 'dev', exceptions: [] });
    expect(p.name).toBe('NextepGuardrails');
    expect(p.ruleIds).toEqual(expect.arrayContaining(['NX-FIN-001', 'NX-POWER-004']));
  });
});

describe('adaptador 2: expectNextepCompliant (helper de Jest)', () => {
  it('pasa con un app conforme', () => {
    expect(() => expectNextepCompliant(cleanApp(), { stage: 'dev' })).not.toThrow();
  });

  it('falla en un app SIN plugin con un Dashboard, listando la violación con stack y recurso', () => {
    expect(() => expectNextepCompliant(appWithDashboard(), { stage: 'dev' })).toThrow(/NX-COST-001.*Obs-Dev\/Board/s);
  });

  it('un stage distinto cambia lo que se exige: el tag Environment=dev no cumple en prod', () => {
    expect(() => expectNextepCompliant(cleanApp(), { stage: 'prod' })).toThrow(/NX-FIN-001/);
  });

  it('respeta exceptions inyectadas (marca + entrada)', () => {
    expect(() => expectNextepCompliant(appWithDashboard({ excepted: true }), { stage: 'dev', exceptions: [ENTRY] })).not.toThrow();
  });
});
