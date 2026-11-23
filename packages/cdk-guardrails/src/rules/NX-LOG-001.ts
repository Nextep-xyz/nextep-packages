import { isLit, isObj, Located, numberOf, ofType, propsOf, where } from '../cfn';
import { literalBool, renderName, resolveTargets } from '../links';
import { Finding, Rule, StackTemplate } from '../types';

/**
 * TECHO DE RETENCIÓN de logs, en días: la ÚNICA constante del paquete para esto (el doc de la regla la nombra y un test lo exige).
 * Un año cubre la auditoría operativa y el análisis interanual de incidentes; por encima, el costo crece sin que el dato se consulte, y quien lo
 * necesite (cumplimiento) lo declara con una excepción con caducidad. Debe ser un valor que CloudWatch Logs acepte (`CW_RETENTION_VALUES`).
 */
export const MAX_LOG_RETENTION_DAYS = 365;

/** Los únicos valores de `retentionInDays` que acepta CloudWatch Logs. */
export const CW_RETENTION_VALUES: readonly number[] = [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653];

interface Declared {
  loc: Located;
  /** Nombre del log group como texto (`<idLógico>` en lugar de un Ref); `complete: false` si tiene huecos. */
  name: { text: string; complete: boolean } | undefined;
}

/** Cada log group que el app DECLARA: un `AWS::Logs::LogGroup` o un `Custom::LogRetention` (su retención se juzga como cualquier otro). */
function declaredGroups(app: StackTemplate[]): Declared[] {
  return [...ofType(app, 'AWS::Logs::LogGroup'), ...ofType(app, 'Custom::LogRetention')].map((loc) => {
    const n = propsOf(loc.res).LogGroupName;
    return { loc, name: n === undefined ? undefined : renderName(n) };
  });
}

/** Un nombre esperado: `local` = usa un `<idLógico>` (solo vale dentro del mismo stack); si no, es un literal y vale en todo el app. */
interface Expected {
  text: string;
  local: boolean;
}

const isDeclared = (declared: Declared[], stack: string, expected: Expected[]): boolean =>
  declared.some((d) => d.name?.complete === true && expected.some((e) => e.text === d.name!.text && (!e.local || d.loc.stack === stack)));

export const rule: Rule = {
  id: 'NX-LOG-001',
  title: 'Ningún log group eterno y todos con techo de retención',
  severity: 'error',
  appliesTo: ['dev', 'stg', 'prod', 'shared'],
  allowsException: true,
  failsClosed: true,
  check(app: StackTemplate[]) {
    const declared = declaredGroups(app);
    const eternal = new Map<string, { loc: Located; msgs: string[] }>(); // no admiten excepción
    const accepted = new Map<string, { loc: Located; msgs: string[] }>(); // admiten excepción (techo, destino externo)
    const add = (bag: typeof eternal, loc: Located, msg: string): void => {
      const k = `${loc.stack}\u0001${loc.id}`;
      const cur = bag.get(k) ?? { loc, msgs: [] };
      if (!cur.msgs.includes(msg)) cur.msgs.push(msg);
      bag.set(k, cur);
    };
    const never = (loc: Located, msg: string): void => add(eternal, loc, msg);
    const maybe = (loc: Located, msg: string): void => add(accepted, loc, msg);

    /** ¿`value` (un nombre o un ARN de log group) es un log group que el app declara? */
    const classify = (loc: Located, value: unknown): 'declared' | 'external' => {
      const r = resolveTargets(app, loc.stack, value);
      if (r.targets.some((t) => t.res.Type === 'AWS::Logs::LogGroup')) return 'declared';
      const name = typeof value === 'string' ? value : undefined;
      if (name !== undefined && declared.some((d) => d.name?.complete === true && d.name.text === name)) return 'declared';
      const rn = renderName(value);
      if (rn.complete && declared.some((d) => d.loc.stack === loc.stack && d.name?.complete === true && d.name.text === rn.text)) return 'declared';
      return 'external';
    };
    const EXTERNAL = (what: string): string => `${what} no es un log group que el app declare (referencia externa o no resoluble): no se puede comprobar su retención. Declare el log group en el app con RetentionInDays, o la excepción con el dueño que lo gobierna`;

    // 1. Los log groups declarados: retención presente, válida y bajo el techo.
    for (const d of declared) {
      const kind = d.loc.res.Type === 'Custom::LogRetention' ? 'Custom::LogRetention' : 'log group';
      const r = propsOf(d.loc.res).RetentionInDays;
      if (r === undefined) {
        never(d.loc, `${kind} sin RetentionInDays: los logs no expiran nunca. Declare una retención <= ${MAX_LOG_RETENTION_DAYS} días (CDK: \`retention: logs.RetentionDays.ONE_MONTH\`)`);
        continue;
      }
      const n = numberOf(r);
      if (n === undefined) maybe(d.loc, `no se puede comprobar RetentionInDays (no es un literal); debe ser <= ${MAX_LOG_RETENTION_DAYS} días`);
      else if (!CW_RETENTION_VALUES.includes(n)) never(d.loc, `RetentionInDays ${n} no es un valor válido de CloudWatch Logs (válidos: ${CW_RETENTION_VALUES.join(', ')}): ${n <= 0 ? 'equivale a no expirar' : 'el deploy lo rechazaría'}`);
      else if (n > MAX_LOG_RETENTION_DAYS) maybe(d.loc, `RetentionInDays ${n} excede el techo de ${MAX_LOG_RETENTION_DAYS} días; baje la retención o declare la excepción con motivo y caducidad`);
    }

    // 2. Lambda: el grupo implícito /aws/lambda/<fn> es eterno si el app no declara uno.
    for (const fn of ofType(app, 'AWS::Lambda::Function')) {
      const p = propsOf(fn.res);
      if (p.LoggingConfig !== undefined && !isLit(p.LoggingConfig)) {
        maybe(fn, 'no se puede comprobar LoggingConfig (no es un literal): no se sabe a qué log group escribe');
        continue;
      }
      const lc = p.LoggingConfig as Record<string, unknown> | undefined;
      if (lc?.LogGroup !== undefined) {
        if (classify(fn, lc.LogGroup) === 'external') maybe(fn, EXTERNAL('LoggingConfig.LogGroup'));
        continue;
      }
      const expected: Expected[] = [{ text: `/aws/lambda/<${fn.id}>`, local: true }];
      if (typeof p.FunctionName === 'string') expected.push({ text: `/aws/lambda/${p.FunctionName}`, local: false });
      if (!isDeclared(declared, fn.stack, expected)) {
        never(fn, `sin log group explícito: el grupo implícito /aws/lambda/<función> que Lambda crea al ejecutarse nunca expira.${lambdaHint(fn)} Declare un log group con RetentionInDays <= ${MAX_LOG_RETENTION_DAYS} y asígnelo en LoggingConfig.LogGroup (CDK: \`logGroup: new logs.LogGroup(…, { retention })\`)`);
      }
    }

    // 3. RDS/Aurora: cada export de CloudWatch Logs crea /aws/rds/(instance|cluster)/<id>/<tipo>.
    for (const db of [...ofType(app, 'AWS::RDS::DBInstance'), ...ofType(app, 'AWS::RDS::DBCluster')]) {
      const p = propsOf(db.res);
      const exp = p.EnableCloudwatchLogsExports;
      if (exp === undefined) continue;
      if (!Array.isArray(exp) || exp.some((x) => typeof x !== 'string')) {
        maybe(db, 'no se puede comprobar EnableCloudwatchLogsExports (no es una lista de literales): no se sabe qué log groups crea RDS');
        continue;
      }
      const base = db.res.Type === 'AWS::RDS::DBCluster' ? '/aws/rds/cluster' : '/aws/rds/instance';
      const ident = typeof p.DBInstanceIdentifier === 'string' ? p.DBInstanceIdentifier : typeof p.DBClusterIdentifier === 'string' ? p.DBClusterIdentifier : undefined;
      for (const t of exp as string[]) {
        const expected: Expected[] = [{ text: `${base}/<${db.id}>/${t}`, local: true }, ...(ident ? [{ text: `${base}/${ident}/${t}`, local: false }] : [])];
        if (!isDeclared(declared, db.stack, expected)) {
          never(db, `exporta el log "${t}" a CloudWatch (${base}/<id>/${t}) y el app no declara ese log group: queda eterno. Declare un log group (o logRetention) con ese nombre y RetentionInDays <= ${MAX_LOG_RETENTION_DAYS} (CDK: \`cloudwatchLogsRetention\`)`);
        }
      }
    }

    // 4. CodeBuild: sin LogsConfig.CloudWatchLogs crea /aws/codebuild/<proyecto>.
    for (const cb of ofType(app, 'AWS::CodeBuild::Project')) {
      const p = propsOf(cb.res);
      if (p.LogsConfig !== undefined && !isLit(p.LogsConfig)) {
        maybe(cb, 'no se puede comprobar LogsConfig (no es un literal)');
        continue;
      }
      const cwl = isLit(p.LogsConfig) ? p.LogsConfig.CloudWatchLogs : undefined;
      if (cwl !== undefined && !isLit(cwl)) {
        maybe(cb, 'no se puede comprobar LogsConfig.CloudWatchLogs (no es un literal)');
        continue;
      }
      if (isLit(cwl) && cwl.Status === 'DISABLED') continue;
      if (isLit(cwl) && cwl.GroupName !== undefined) {
        if (classify(cb, cwl.GroupName) === 'external') maybe(cb, EXTERNAL('LogsConfig.CloudWatchLogs.GroupName'));
        continue;
      }
      const expected: Expected[] = [{ text: `/aws/codebuild/<${cb.id}>`, local: true }, ...(typeof p.Name === 'string' ? [{ text: `/aws/codebuild/${p.Name}`, local: false }] : [])];
      if (!isDeclared(declared, cb.stack, expected)) never(cb, `sin LogsConfig.CloudWatchLogs.GroupName: CodeBuild crea el grupo implícito /aws/codebuild/<proyecto> sin retención. Declare un log group con RetentionInDays <= ${MAX_LOG_RETENTION_DAYS} y asígnelo en LogsConfig`);
    }

    // 5. ECS: driver awslogs (contenedores de la task definition y log del Service Connect).
    const awslogs = (loc: Located, cfg: unknown, where_: string): void => {
      if (cfg === undefined) return;
      if (!isLit(cfg)) return maybe(loc, `no se puede comprobar ${where_} (no es un literal)`);
      if (cfg.LogDriver !== 'awslogs') return;
      if (cfg.Options !== undefined && !isLit(cfg.Options)) return maybe(loc, `no se puede comprobar ${where_}.Options (no es un literal)`);
      const o = (cfg.Options ?? {}) as Record<string, unknown>;
      const group = o['awslogs-group'];
      if (group === undefined) return;
      if (classify(loc, group) === 'declared') return;
      if (literalBool(o['awslogs-create-group']) === true) {
        never(loc, `${where_} usa awslogs-create-group: ECS crea el log group sin retención y queda eterno. Declare el log group en el app con RetentionInDays <= ${MAX_LOG_RETENTION_DAYS} (CDK: \`logging: ecs.LogDrivers.awsLogs({ logGroup })\`)`);
      } else maybe(loc, EXTERNAL(`${where_} (awslogs-group)`));
    };
    for (const td of ofType(app, 'AWS::ECS::TaskDefinition')) {
      const defs = propsOf(td.res).ContainerDefinitions;
      if (defs === undefined) continue;
      if (!Array.isArray(defs)) {
        maybe(td, 'no se puede comprobar ContainerDefinitions (no es una lista literal)');
        continue;
      }
      defs.forEach((c, i) => {
        if (!isLit(c)) return maybe(td, `no se puede comprobar ContainerDefinitions[${i}] (no es un literal)`);
        awslogs(td, c.LogConfiguration, `ContainerDefinitions[${i}].LogConfiguration`);
      });
    }
    for (const s of ofType(app, 'AWS::ECS::Service')) {
      const sc = propsOf(s.res).ServiceConnectConfiguration;
      if (isLit(sc)) awslogs(s, sc.LogConfiguration, 'ServiceConnectConfiguration.LogConfiguration');
    }

    // 6. API Gateway: destino del access log y log de ejecución implícito.
    const destination = (loc: Located, value: unknown, what: string): void => {
      if (value !== undefined && classify(loc, value) === 'external') maybe(loc, EXTERNAL(what));
    };
    for (const st of ofType(app, 'AWS::ApiGateway::Stage')) {
      const p = propsOf(st.res);
      if (isLit(p.AccessLogSetting)) destination(st, p.AccessLogSetting.DestinationArn, 'AccessLogSetting.DestinationArn');
      const ms = p.MethodSettings;
      if (ms !== undefined && !Array.isArray(ms)) {
        maybe(st, 'no se puede comprobar MethodSettings (no es una lista literal)');
        continue;
      }
      const levels = ((ms ?? []) as unknown[]).map((m) => (isLit(m) ? m.LoggingLevel : 'unknown'));
      if (levels.some((l) => l === 'unknown' || (l !== undefined && typeof l !== 'string'))) {
        maybe(st, 'no se puede comprobar MethodSettings[].LoggingLevel (no es un literal)');
      } else if (levels.some((l) => l === 'ERROR' || l === 'INFO')) {
        const api = renderName(p.RestApiId);
        const stage = renderName(p.StageName);
        if (!api.complete || !stage.complete) {
          maybe(st, 'tiene LoggingLevel de ejecución y no se puede calcular el nombre del log group implícito (RestApiId o StageName no resolubles)');
        } else if (!isDeclared(declared, st.stack, [{ text: `API-Gateway-Execution-Logs_${api.text}/${stage.text}`, local: true }])) {
          never(st, `MethodSettings activa el log de ejecución (LoggingLevel ERROR/INFO): API Gateway crea el grupo implícito API-Gateway-Execution-Logs_<api>/<stage> sin retención. Declare un log group con ese nombre y RetentionInDays <= ${MAX_LOG_RETENTION_DAYS}, o ponga LoggingLevel OFF`);
        }
      }
    }
    for (const st of ofType(app, 'AWS::ApiGatewayV2::Stage')) {
      const a = propsOf(st.res).AccessLogSettings;
      if (isLit(a)) destination(st, a.DestinationArn, 'AccessLogSettings.DestinationArn');
    }

    // 7. Step Functions y VPC Flow Logs: destinos explícitos.
    for (const sm of ofType(app, 'AWS::StepFunctions::StateMachine')) {
      const lc = propsOf(sm.res).LoggingConfiguration;
      if (!isLit(lc) || lc.Destinations === undefined) continue;
      if (!Array.isArray(lc.Destinations)) {
        maybe(sm, 'no se puede comprobar LoggingConfiguration.Destinations (no es una lista literal)');
        continue;
      }
      for (const d of lc.Destinations as unknown[]) {
        const arn = isLit(d) && isLit(d.CloudWatchLogsLogGroup) ? d.CloudWatchLogsLogGroup.LogGroupArn : undefined;
        destination(sm, arn, 'LoggingConfiguration.Destinations[].CloudWatchLogsLogGroup.LogGroupArn');
      }
    }
    for (const fl of ofType(app, 'AWS::EC2::FlowLog')) {
      const p = propsOf(fl.res);
      if (p.LogDestinationType !== undefined && p.LogDestinationType !== 'cloud-watch-logs') continue; // s3 o firehose
      destination(fl, p.LogGroupName ?? p.LogDestination, p.LogGroupName !== undefined ? 'LogGroupName' : 'LogDestination');
    }

    const out: Finding[] = [];
    const emit = (bag: typeof eternal, exceptable: boolean): void => {
      for (const { loc, msgs } of bag.values()) {
        out.push({
          stack: loc.stack,
          resource: loc.id,
          exceptable,
          message: `[NX-LOG-001] ${where(loc)}: ${msgs.join('; ')}.${exceptable ? '' : ' Este hallazgo NO admite excepción.'} Ver docs/rules/NX-LOG-001.md`,
        });
      }
    };
    emit(eternal, false);
    emit(accepted, true);
    return out;
  },
};

/** Qué construct de CDK suele estar detrás de una Lambda sin log group (por la ruta de CDK del template) y cómo arreglarlo. */
function lambdaHint(fn: Located): string {
  const path = isObj(fn.res.Metadata) && typeof fn.res.Metadata['aws:cdk:path'] === 'string' ? (fn.res.Metadata['aws:cdk:path'] as string) : '';
  if (/\/LogRetention[0-9a-f]{8,}\//.test(path)) return ' Es la Lambda auxiliar de Custom::LogRetention (CDK): reemplace `logRetention` por `logGroup` en los constructs que la crean.';
  if (/\/framework-(onEvent|isComplete|onTimeout)\//.test(path)) return ' Es el framework de un cr.Provider: pase `logGroup: new logs.LogGroup(…, { retention })` al Provider.';
  if (/CustomResourceProvider/.test(path)) return ' Es un CustomResourceProvider interno de CDK: declare un logs.LogGroup con logGroupName `/aws/lambda/${fn.ref}` (L1 de la función) y retención.';
  if (/AWS[0-9a-f]{32}/.test(path) || /AwsCustomResource/.test(path)) return ' Es la Lambda de un AwsCustomResource: pase `logGroup` al construct.';
  return '';
}
