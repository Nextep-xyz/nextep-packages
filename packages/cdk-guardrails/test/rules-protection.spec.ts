import type { Stage } from '@guardrails/src/types';
import { entry, marked, msgs, oneStack, R, run, stack } from '@guardrails/test/helpers';

// Bordes de NX-PROT-001 y NX-S3-001 (spec guardrails-prod-readiness §3.8 y §3.6) que los fixtures no cubren.

const db = (p: Record<string, unknown> = {}): ReturnType<typeof R> => R('AWS::RDS::DBInstance', { DBInstanceClass: 'db.t4g.medium', Engine: 'postgres', ...p });
const alb = (p: Record<string, unknown> = {}): ReturnType<typeof R> => R('AWS::ElasticLoadBalancingV2::LoadBalancer', { Type: 'application', ...p });

describe('NX-PROT-001: bordes', () => {
  it('solo corre en prod', () => {
    const app = oneStack('Db', { D: db() });
    expect(run(app, 'prod', 'NX-PROT-001')).toEqual(['Db/D']);
    for (const st of ['dev', 'stg', 'shared'] as Stage[]) expect(run(app, st, 'NX-PROT-001')).toEqual([]);
  });

  it('DeletionProtection como texto "true" cuenta; "false" y ausente no', () => {
    expect(run(oneStack('Db', { D: db({ DeletionProtection: 'true' }) }), 'prod', 'NX-PROT-001')).toEqual([]);
    expect(run(oneStack('Db', { D: db({ DeletionProtection: 'false' }) }), 'prod', 'NX-PROT-001')).toEqual(['Db/D']);
    expect(msgs(oneStack('Db', { D: db() }), 'prod', 'NX-PROT-001')).toMatch(/ausente \(el default es false\)/);
  });

  it('un Aurora: el cluster se juzga y su instancia miembro no; una réplica de cluster (ReplicationSourceIdentifier) tampoco', () => {
    const app = oneStack('Db', {
      Cluster: R('AWS::RDS::DBCluster', { Engine: 'aurora-postgresql' }),
      Member: db({ DBClusterIdentifier: { Ref: 'Cluster' } }),
      SecondaryCluster: R('AWS::RDS::DBCluster', { Engine: 'aurora-postgresql', ReplicationSourceIdentifier: 'arn' }),
    });
    expect(run(app, 'prod', 'NX-PROT-001')).toEqual(['Db/Cluster']);
  });

  it('ALB: el atributo en "false" falla; un NLB no es sujeto; un Type intrinsic falla cerrado', () => {
    const attrs = (v: unknown): unknown => [{ Key: 'deletion_protection.enabled', Value: v }];
    expect(run(oneStack('E', { L: alb({ LoadBalancerAttributes: attrs('false') }) }), 'prod', 'NX-PROT-001')).toEqual(['E/L']);
    expect(run(oneStack('E', { L: alb({ Type: 'network' }) }), 'prod', 'NX-PROT-001')).toEqual([]);
    expect(msgs(oneStack('E', { L: alb({ Type: { Ref: 'P' } }) }), 'prod', 'NX-PROT-001')).toMatch(/no se puede comprobar el tipo de balanceador/);
    expect(run(oneStack('E', { L: alb({ LoadBalancerAttributes: attrs('true') }) }), 'prod', 'NX-PROT-001')).toEqual([]);
  });

  it('ALB sin Type (default application) también es sujeto', () => {
    expect(run(oneStack('E', { L: R('AWS::ElasticLoadBalancingV2::LoadBalancer', {}) }), 'prod', 'NX-PROT-001')).toEqual(['E/L']);
  });

  it('TerminationProtection: con manifest, un stack sin protección falla nombrando <stack>/(stack) y NO admite excepción', () => {
    const app = [stack('Core', { Q: R('AWS::SQS::Queue') }, {}, { region: 'us-east-2', terminationProtection: false })];
    expect(run(app, 'prod', 'NX-PROT-001')).toEqual(['Core/(stack)']);
    expect(msgs(app, 'prod', 'NX-PROT-001')).toMatch(/TerminationProtection desactivada/);
    const marked2 = [stack('Core', { Q: marked(R('AWS::SQS::Queue'), 'NX-PROT-001') }, {}, { terminationProtection: false })];
    expect(run(marked2, 'prod', 'NX-PROT-001', { exceptions: [entry('NX-PROT-001')] })).toEqual(['Core/(stack)']);
  });

  it('TerminationProtection: SIN ningún manifest (solo templates) esa parte no se evalúa; con manifest parcial, el stack sin meta falla cerrado', () => {
    expect(run(oneStack('Core', { Q: R('AWS::SQS::Queue') }), 'prod', 'NX-PROT-001')).toEqual([]);
    const partial = [stack('A', {}, {}, { terminationProtection: true }), stack('B', {})];
    expect(run(partial, 'prod', 'NX-PROT-001')).toEqual(['B/(stack)']);
    expect(msgs(partial, 'prod', 'NX-PROT-001')).toMatch(/no figura en manifest\.json/);
  });

  it('la excepción de un recurso (marca + entrada) sí silencia a la DB', () => {
    const app = oneStack('Db', { D: marked(db(), 'NX-PROT-001') });
    expect(run(app, 'prod', 'NX-PROT-001', { exceptions: [entry('NX-PROT-001')] })).toEqual([]);
  });
});

const PAB = { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true };
const bucket = (p: Record<string, unknown> = {}): ReturnType<typeof R> => R('AWS::S3::Bucket', { VersioningConfiguration: { Status: 'Enabled' }, PublicAccessBlockConfiguration: PAB, ...p });
const sslStatement = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  Action: 's3:*',
  Effect: 'Deny',
  Principal: { AWS: '*' },
  Condition: { Bool: { 'aws:SecureTransport': 'false' } },
  Resource: [{ 'Fn::GetAtt': [id, 'Arn'] }, { 'Fn::Join': ['', [{ 'Fn::GetAtt': [id, 'Arn'] }, '/*']] }],
  ...over,
});
const policy = (id: string, st: unknown): ReturnType<typeof R> => R('AWS::S3::BucketPolicy', { Bucket: { Ref: id }, PolicyDocument: { Statement: Array.isArray(st) ? st : [st] } });

describe('NX-S3-001: bordes', () => {
  it('solo corre en prod', () => {
    const app = oneStack('S', { B: R('AWS::S3::Bucket', {}) });
    expect(run(app, 'prod', 'NX-S3-001')).toEqual(['S/B']);
    for (const st of ['dev', 'stg', 'shared'] as Stage[]) expect(run(app, st, 'NX-S3-001')).toEqual([]);
  });

  it('el mensaje enumera TODO lo que falta (versioning, bloqueo, política)', () => {
    expect(msgs(oneStack('S', { B: R('AWS::S3::Bucket', {}) }), 'prod', 'NX-S3-001')).toMatch(/sin VersioningConfiguration.*sin PublicAccessBlockConfiguration.*sin política que niegue el transporte inseguro/);
  });

  it('cada flag del bloqueo público se exige: uno en false lo nombra', () => {
    for (const flag of Object.keys(PAB)) {
      const app = oneStack('S', { B: bucket({ PublicAccessBlockConfiguration: { ...PAB, [flag]: false } }), P: policy('B', sslStatement('B')) });
      expect(msgs(app, 'prod', 'NX-S3-001')).toContain(`${flag} no es true`);
    }
  });

  it('un bucket completo (con la forma real de enforceSSL) pasa; la política sin la mitad de objetos (/*) no', () => {
    expect(run(oneStack('S', { B: bucket(), P: policy('B', sslStatement('B')) }), 'prod', 'NX-S3-001')).toEqual([]);
    const noObjects = sslStatement('B', { Resource: { 'Fn::GetAtt': ['B', 'Arn'] } });
    expect(run(oneStack('S', { B: bucket(), P: policy('B', noObjects) }), 'prod', 'NX-S3-001')).toEqual(['S/B']);
  });

  it.each([
    ['Effect Allow', { Effect: 'Allow' }],
    ['SecureTransport = true', { Condition: { Bool: { 'aws:SecureTransport': 'true' } } }],
    ['sin Principal comodín', { Principal: { AWS: 'arn:aws:iam::<ACCOUNT>:root' } }],
    ['Action s3:GetObject', { Action: 's3:GetObject' }],
  ])('la sentencia no cuenta si %s', (_n, over) => {
    expect(run(oneStack('S', { B: bucket(), P: policy('B', sslStatement('B', over)) }), 'prod', 'NX-S3-001')).toEqual(['S/B']);
  });

  it('la política de OTRO bucket no cubre a éste', () => {
    const app = oneStack('S', { A: bucket(), B: bucket(), P: policy('A', sslStatement('A')) });
    expect(run(app, 'prod', 'NX-S3-001')).toEqual(['S/B']);
  });

  it('la política en otro stack, enlazada por export, cubre al bucket', () => {
    const data = stack('Data', { B: bucket() }, { Outputs: { Out: { Value: { Ref: 'B' }, Export: { Name: 'Data:ExportsOutputRefB' } } } });
    const pol = stack('Pol', {
      P: R('AWS::S3::BucketPolicy', {
        Bucket: { 'Fn::ImportValue': 'Data:ExportsOutputRefB' },
        PolicyDocument: { Statement: [sslStatement('B', { Resource: [{ 'Fn::ImportValue': 'Data:ExportsOutputArn' }, { 'Fn::Join': ['', [{ 'Fn::ImportValue': 'Data:ExportsOutputArn' }, '/*']] }] })] },
      }),
    });
    const withArn = stack('Data', { B: bucket() }, { Outputs: { Out: { Value: { Ref: 'B' }, Export: { Name: 'Data:ExportsOutputRefB' } }, Arn: { Value: { 'Fn::GetAtt': ['B', 'Arn'] }, Export: { Name: 'Data:ExportsOutputArn' } } } });
    expect(run([withArn, pol], 'prod', 'NX-S3-001')).toEqual([]);
    expect(run([data, pol], 'prod', 'NX-S3-001')).toEqual(['Data/B']); // sin el export del ARN el Resource no apunta al bucket: no se da por bueno
  });

  describe('exención de los buckets de logs de acceso (solo versioning, solo si el app los usa de destino)', () => {
    const logBucket = (): ReturnType<typeof R> => R('AWS::S3::Bucket', { PublicAccessBlockConfiguration: PAB });
    const withAlb = (id = 'Logs'): ReturnType<typeof R> =>
      alb({ LoadBalancerAttributes: [{ Key: 'access_logs.s3.bucket', Value: { Ref: id } }] });

    it('un bucket que un ALB usa de destino queda exento del versioning', () => {
      const app = oneStack('E', { Logs: logBucket(), LogsPolicy: policy('Logs', sslStatement('Logs')), Alb: withAlb() });
      expect(run(app, 'prod', 'NX-S3-001')).toEqual([]);
    });

    it('el MISMO bucket sin ALB que lo use no se exime: el criterio es el uso, no un tag ni un nombre', () => {
      const tagged = R('AWS::S3::Bucket', { PublicAccessBlockConfiguration: PAB, Tags: [{ Key: 'nextep:bucket-role', Value: 'access-logs' }] });
      const app = oneStack('E', { Logs: tagged, LogsPolicy: policy('Logs', sslStatement('Logs')) });
      expect(msgs(app, 'prod', 'NX-S3-001')).toMatch(/sin VersioningConfiguration/);
    });

    it('la exención NO alcanza al bloqueo público ni al TLS del bucket de logs', () => {
      const app = oneStack('E', { Logs: R('AWS::S3::Bucket', {}), Alb: withAlb() });
      const m = msgs(app, 'prod', 'NX-S3-001');
      expect(m).not.toMatch(/VersioningConfiguration/);
      expect(m).toMatch(/sin PublicAccessBlockConfiguration/);
      expect(m).toMatch(/sin política que niegue el transporte inseguro/);
    });

    it('el destino por export desde otro stack (ALB en Edge, bucket en Logs) también se reconoce', () => {
      const logs = stack('Logs', { B: logBucket(), P: policy('B', sslStatement('B')) }, { Outputs: { O: { Value: { Ref: 'B' }, Export: { Name: 'Logs:ExportsOutputRefB' } } } });
      const edge = stack('Edge', { Alb: alb({ LoadBalancerAttributes: [{ Key: 'access_logs.s3.bucket', Value: { 'Fn::ImportValue': 'Logs:ExportsOutputRefB' } }] }) });
      expect(run([logs, edge], 'prod', 'NX-S3-001')).toEqual([]);
    });

    it('CloudFront (Logging.Bucket por GetAtt del dominio) y el server access logging de otro bucket también cuentan', () => {
      const cf = R('AWS::CloudFront::Distribution', { DistributionConfig: { Logging: { Bucket: { 'Fn::GetAtt': ['CfLogs', 'RegionalDomainName'] } } } });
      const src = bucket({ LoggingConfiguration: { DestinationBucketName: { Ref: 'AccessLogs' } } });
      const app = oneStack('S', {
        CfLogs: logBucket(), CfLogsP: policy('CfLogs', sslStatement('CfLogs')), Cf: cf,
        AccessLogs: logBucket(), AccessLogsP: policy('AccessLogs', sslStatement('AccessLogs')),
        Src: src, SrcP: policy('Src', sslStatement('Src')),
      });
      expect(run(app, 'prod', 'NX-S3-001')).toEqual([]);
    });
  });

  it('admite excepción declarada dos veces (p. ej. un sitio estático público)', () => {
    const app = oneStack('S', { B: marked(R('AWS::S3::Bucket', {}), 'NX-S3-001') });
    expect(run(app, 'prod', 'NX-S3-001', { exceptions: [entry('NX-S3-001')] })).toEqual([]);
  });
});
