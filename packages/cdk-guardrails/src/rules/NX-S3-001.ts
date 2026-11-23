import { isLit, isObj, Located, ofType, propsOf, where } from '../cfn';
import { literalBool, pointsTo, renderName, resolveTargets } from '../links';
import { Finding, Rule, StackTemplate } from '../types';

const PAB_FLAGS = ['BlockPublicAcls', 'BlockPublicPolicy', 'IgnorePublicAcls', 'RestrictPublicBuckets'] as const;
const key = (l: { stack: string; id: string }): string => `${l.stack}\u0001${l.id}`;

/**
 * Buckets que el PROPIO app usa como destino de logs de acceso (ALB, CLB, CloudFront o el server access logging de otro bucket). Criterio
 * estructural (spec §3.6): un hecho del template, no un tag que se pueda poner en un bucket de datos para esquivar la regla.
 */
function accessLogBuckets(app: StackTemplate[]): Set<string> {
  const out = new Set<string>();
  const addFrom = (stack: string, value: unknown): void => {
    for (const t of resolveTargets(app, stack, value).targets) if (t.res.Type === 'AWS::S3::Bucket') out.add(key(t));
  };
  for (const l of ofType(app, 'AWS::ElasticLoadBalancingV2::LoadBalancer')) {
    const attrs = propsOf(l.res).LoadBalancerAttributes;
    if (!Array.isArray(attrs)) continue;
    for (const a of attrs) if (isObj(a) && a.Key === 'access_logs.s3.bucket') addFrom(l.stack, a.Value);
  }
  for (const l of ofType(app, 'AWS::ElasticLoadBalancing::LoadBalancer')) {
    const pol = propsOf(l.res).AccessLoggingPolicy;
    if (isObj(pol)) addFrom(l.stack, pol.S3BucketName);
  }
  for (const l of ofType(app, 'AWS::S3::Bucket')) {
    const lc = propsOf(l.res).LoggingConfiguration;
    if (isObj(lc)) addFrom(l.stack, lc.DestinationBucketName);
  }
  for (const l of ofType(app, 'AWS::CloudFront::Distribution')) {
    const cfg = propsOf(l.res).DistributionConfig;
    const logging = isObj(cfg) ? cfg.Logging : undefined;
    if (isObj(logging)) addFrom(l.stack, logging.Bucket);
  }
  return out;
}

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
const hasWildcard = (v: unknown): boolean => asList(v).some((x) => x === '*');

/** ¿La sentencia es el `Deny` de transporte inseguro que genera `enforceSSL`? (Deny + Principal * + s3:* + Bool aws:SecureTransport=false + cubre el bucket y sus objetos) */
function deniesInsecureTransport(app: StackTemplate[], policy: Located, st: unknown, bucket: Located): boolean {
  if (!isObj(st) || st.Effect !== 'Deny') return false;
  const cond = isObj(st.Condition) && isObj(st.Condition.Bool) ? st.Condition.Bool : undefined;
  if (!cond || literalBool(cond['aws:SecureTransport']) !== false) return false;
  const principal = isObj(st.Principal) ? st.Principal.AWS : st.Principal;
  if (!hasWildcard(principal)) return false;
  if (!asList(st.Action).some((a) => a === 's3:*' || a === '*')) return false;
  const resources = asList(st.Resource);
  const forObjects = (r: unknown): boolean => renderName(r).text.endsWith('/*');
  const bucketLevel = resources.some((r) => r === '*' || (!forObjects(r) && pointsTo(app, policy.stack, r, bucket)));
  const objectLevel = resources.some((r) => r === '*' || (forObjects(r) && pointsTo(app, policy.stack, r, bucket)));
  return bucketLevel && objectLevel;
}

/**
 * NX-S3-001: todo bucket tiene versioning `Enabled`, `PublicAccessBlockConfiguration` completa y una política que niega el transporte
 * inseguro. Exención ÚNICA: un bucket que el app usa como destino de logs de acceso queda exento SOLO del versioning (acumularía versiones
 * no actuales sin valor); el bloqueo público y el TLS se le siguen exigiendo.
 */
export const rule: Rule = {
  id: 'NX-S3-001',
  title: 'En prod todo bucket: versioning, bloqueo público completo y TLS obligatorio',
  severity: 'error',
  appliesTo: ['prod'],
  allowsException: true,
  failsClosed: true,
  check(app: StackTemplate[]) {
    const findings: Finding[] = [];
    const logBuckets = accessLogBuckets(app);
    const policies = ofType(app, 'AWS::S3::BucketPolicy');

    for (const b of ofType(app, 'AWS::S3::Bucket')) {
      const p = propsOf(b.res);
      const problems: string[] = [];
      const unknown: string[] = [];

      if (!logBuckets.has(key(b))) {
        const vc = p.VersioningConfiguration;
        if (vc === undefined) problems.push('sin VersioningConfiguration (versioning desactivado)');
        else if (!isLit(vc) || typeof vc.Status !== 'string') unknown.push('VersioningConfiguration.Status');
        else if (vc.Status !== 'Enabled') problems.push(`versioning ${vc.Status} (debe ser Enabled)`);
      }

      const pab = p.PublicAccessBlockConfiguration;
      if (pab === undefined) problems.push('sin PublicAccessBlockConfiguration');
      else if (!isLit(pab)) unknown.push('PublicAccessBlockConfiguration');
      else {
        const off: string[] = [];
        for (const f of PAB_FLAGS) {
          const v = literalBool(pab[f]);
          if (pab[f] !== undefined && v === undefined) unknown.push(`PublicAccessBlockConfiguration.${f}`);
          else if (v !== true) off.push(f);
        }
        if (off.length) problems.push(`bloqueo público incompleto (${off.join(', ')} no es true)`);
      }

      const mine = policies.filter((pol) => pointsTo(app, pol.stack, propsOf(pol.res).Bucket, b));
      const opaque = mine.some((pol) => !isLit(propsOf(pol.res).PolicyDocument));
      const ok = mine.some((pol) => {
        const doc = propsOf(pol.res).PolicyDocument;
        return isLit(doc) && asList(doc.Statement).some((st) => deniesInsecureTransport(app, pol, st, b));
      });
      if (!ok) {
        if (opaque) unknown.push('PolicyDocument de la política del bucket');
        else problems.push('sin política que niegue el transporte inseguro (Deny de aws:SecureTransport=false; CDK: `enforceSSL: true`)');
      }

      if (problems.length || unknown.length) {
        const parts = [...problems, ...(unknown.length ? [`no se puede comprobar ${unknown.join(', ')} (no es un literal)`] : [])];
        findings.push({ stack: b.stack, resource: b.id, message: `[NX-S3-001] ${where(b)}: ${parts.join('; ')}. Ver docs/rules/NX-S3-001.md` });
      }
    }
    return findings;
  },
};
