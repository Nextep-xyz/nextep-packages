import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { literalBool, pointsTo, renderName, resolveTargets } from '@guardrails/src/links';
import { loadTemplatesFromDir, readManifestMeta } from '@guardrails/src/adapters/load';
import type { StackTemplate } from '@guardrails/src/types';

// GR-LK / GR-META (spec guardrails-prod-readiness §2.2, §2.3): la resolución de referencias entre recursos y stacks, y los metadatos del manifest.

const ids = (app: StackTemplate[], stack: string, v: unknown): string[] =>
  resolveTargets(app, stack, v)
    .targets.map((t) => `${t.stack}/${t.id}`)
    .sort();

const SSM_PARAM = 'SsmParameterValuealarmtopicarnParameter';
const APP: StackTemplate[] = [
  {
    stack: 'Obs',
    template: {
      Resources: {
        Topic: { Type: 'AWS::SNS::Topic' },
        TopicArnParam: { Type: 'AWS::SSM::Parameter', Properties: { Name: '/shop/prod/alarm-topic-arn', Value: { Ref: 'Topic' } } },
      },
      Outputs: { TopicOut: { Value: { Ref: 'Topic' }, Export: { Name: 'Obs:ExportsOutputRefTopic' } } },
    },
  },
  {
    stack: 'Svc',
    template: {
      Parameters: {
        [SSM_PARAM]: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/shop/prod/alarm-topic-arn' },
        Foreign: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/elsewhere/not-declared' },
        Plain: { Type: 'String' },
      },
      Resources: { Alarm: { Type: 'AWS::CloudWatch::Alarm' }, Local: { Type: 'AWS::SQS::Queue' } },
    },
  },
];

describe('resolveTargets', () => {
  it('Ref y GetAtt locales (forma de lista y de texto)', () => {
    expect(ids(APP, 'Svc', { Ref: 'Local' })).toEqual(['Svc/Local']);
    expect(ids(APP, 'Svc', { 'Fn::GetAtt': ['Local', 'Arn'] })).toEqual(['Svc/Local']);
    expect(ids(APP, 'Svc', { 'Fn::GetAtt': 'Local.Arn' })).toEqual(['Svc/Local']);
  });

  it('recorre Fn::Join y listas; los literales y los pseudo-parámetros no son referencias', () => {
    const v = { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':x:', { Ref: 'Local' }, '/', 'literal']] };
    const r = resolveTargets(APP, 'Svc', [v, 'otro']);
    expect(r.targets.map((t) => t.id)).toEqual(['Local']);
    expect(r.unresolved).toBe(false);
  });

  it('Fn::Sub: sigue ${recurso} y ${recurso.Atributo}; ignora ${AWS::…}', () => {
    expect(ids(APP, 'Svc', { 'Fn::Sub': 'arn:${AWS::Partition}:sqs:::${Local}/${Local.Arn}' })).toEqual(['Svc/Local']);
    expect(resolveTargets(APP, 'Svc', { 'Fn::Sub': '${Ghost}' }).unresolved).toBe(true);
    expect(ids(APP, 'Svc', { 'Fn::Sub': ['${V}', { V: { Ref: 'Local' } }] })).toEqual(['Svc/Local']);
  });

  it('salto por SSM: un parámetro SSM de un stack apunta al recurso que otro stack escribió en ese nombre (la forma real de los stacks de referencia)', () => {
    expect(ids(APP, 'Svc', { Ref: SSM_PARAM })).toEqual(['Obs/Topic']);
  });

  it('un parámetro SSM que el app no escribe, un parámetro común y un Ref a algo inexistente quedan SIN resolver', () => {
    for (const v of [{ Ref: 'Foreign' }, { Ref: 'Plain' }, { Ref: 'Ghost' }]) {
      const r = resolveTargets(APP, 'Svc', v);
      expect(r).toEqual({ targets: [], unresolved: true });
    }
  });

  it('Fn::ImportValue: sigue el export al recurso del stack que lo declara', () => {
    expect(ids(APP, 'Svc', { 'Fn::ImportValue': 'Obs:ExportsOutputRefTopic' })).toEqual(['Obs/Topic']);
  });

  it('un export que el app no declara, o un nombre no literal, queda sin resolver', () => {
    expect(resolveTargets(APP, 'Svc', { 'Fn::ImportValue': 'Otro:Export' }).unresolved).toBe(true);
    expect(resolveTargets(APP, 'Svc', { 'Fn::ImportValue': { Ref: 'Plain' } }).unresolved).toBe(true);
  });

  it('un ciclo (el valor del parámetro SSM apunta al propio parámetro) termina y no cuelga', () => {
    const cyc: StackTemplate[] = [
      {
        stack: 'A',
        template: {
          Parameters: { P: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/loop' } },
          Resources: { W: { Type: 'AWS::SSM::Parameter', Properties: { Name: '/loop', Value: { Ref: 'P' } } } },
        },
      },
    ];
    expect(resolveTargets(cyc, 'A', { Ref: 'P' }).targets).toEqual([]);
  });

  it('pointsTo compara stack e id', () => {
    expect(pointsTo(APP, 'Svc', { Ref: SSM_PARAM }, { stack: 'Obs', id: 'Topic' })).toBe(true);
    expect(pointsTo(APP, 'Svc', { Ref: SSM_PARAM }, { stack: 'Svc', id: 'Topic' })).toBe(false);
  });
});

describe('renderName / literalBool', () => {
  it('arma el nombre con <idLógico> en lugar del Ref a un recurso', () => {
    expect(renderName({ 'Fn::Join': ['', ['/aws/lambda/', { Ref: 'Fn' }]] })).toEqual({ text: '/aws/lambda/<Fn>', complete: true });
    expect(renderName({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }]] })).toEqual({ text: 'arn:aws', complete: true });
  });

  it('un pseudo-parámetro que no es la partición o un intrinsic desconocido deja un hueco (incompleto)', () => {
    expect(renderName({ 'Fn::Join': ['', ['x-', { Ref: 'AWS::Region' }]] }).complete).toBe(false);
    expect(renderName({ 'Fn::If': ['c', 'a', 'b'] }).complete).toBe(false);
  });

  it('literalBool acepta true/"true"/false/"false" y rechaza el resto', () => {
    expect([true, 'true', false, 'false', 'x', { Ref: 'P' }, undefined, 1].map(literalBool)).toEqual([true, true, false, false, undefined, undefined, undefined, undefined]);
  });
});

describe('manifest.json: región y terminationProtection (lo que el template no expone)', () => {
  const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-manifest-'));
  const write = (dir: string, name: string, content: unknown): void => fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  const manifest = {
    version: '1.0.0',
    artifacts: {
      'Db-Prod': { type: 'aws:cloudformation:stack', environment: 'aws://<ACCOUNT>/us-east-2', properties: { templateFile: 'Db-Prod.template.json', terminationProtection: true } },
      Open: { type: 'aws:cloudformation:stack', environment: 'aws://unknown-account/unknown-region', properties: { templateFile: 'Open.template.json' } },
      'Db-Prod.assets': { type: 'cdk:asset-manifest', properties: { file: 'x.json' } },
    },
  };

  it('lee región y terminationProtection por archivo de template; unknown-region = sin región; sin la propiedad = false', () => {
    const dir = tmp();
    write(dir, 'manifest.json', manifest);
    const m = readManifestMeta(dir);
    expect(m?.get('Db-Prod.template.json')).toEqual({ region: 'us-east-2', terminationProtection: true });
    expect(m?.get('Open.template.json')).toEqual({ region: undefined, terminationProtection: false });
    expect(m?.has('Db-Prod.assets')).toBe(false);
  });

  it('loadTemplatesFromDir adjunta `meta`; un template que no figura en el manifest queda SIN meta (la regla lo reporta, no se inventa un valor)', () => {
    const dir = tmp();
    write(dir, 'manifest.json', manifest);
    for (const n of ['Db-Prod', 'Open', 'Ghost']) write(dir, `${n}.template.json`, { Resources: {} });
    const byStack = Object.fromEntries(loadTemplatesFromDir(dir).map((t) => [t.stack, t.meta]));
    expect(byStack['Db-Prod']).toEqual({ region: 'us-east-2', terminationProtection: true });
    expect(byStack.Ghost).toBeUndefined();
  });

  it('sin manifest.json (uso solo-templates): meta es undefined en todos', () => {
    const dir = tmp();
    write(dir, 'S.template.json', { Resources: {} });
    expect(readManifestMeta(dir)).toBeUndefined();
    expect(loadTemplatesFromDir(dir)[0]?.meta).toBeUndefined();
  });

  it('un manifest corrupto LANZA: no equivale a «sin manifest»', () => {
    const dir = tmp();
    write(dir, 'manifest.json', '{no es json');
    expect(() => readManifestMeta(dir)).toThrow(/No se pudo leer .*manifest\.json/);
  });
});
