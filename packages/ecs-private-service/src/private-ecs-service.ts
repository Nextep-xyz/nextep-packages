import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { ServiceEnvironment, validateProps } from './validation';

const DEFAULT_PORT = 8000;
const DEFAULT_HEALTH_PATH = '/api/v1/health';
const DEFAULT_MIGRATE = ['alembic', 'upgrade', 'head'];
const API_PREFIX = '/api/v1';
const TMP_PATH = '/tmp';
const TMP_VOLUME = 'tmp';

export interface PrivateEcsServiceProps {
  /** Cluster ECS existente donde corre el servicio. Su VPC debe ser `vpc`. */
  readonly cluster: ecs.ICluster;
  readonly vpc: ec2.IVpc;
  /** Nombre del servicio ECS (unico en el cluster) y, salvo `serviceConnect.dnsName`, su nombre DNS de Service Connect. */
  readonly serviceName: string;
  /**
   * Imagen inmutable: version semver exacta y digest `sha256:`. Se referencia como `<repositoryUri>@<digest>` (el tag no es identidad) y
   * el construct concede el pull al execution role.
   */
  readonly image: { readonly repository: ecr.IRepository; readonly version: string; readonly digest: string };
  /**
   * Secreto con la URL de conexion COMPLETA en el campo `databaseUrlField`. El construct no conoce el schema ni crea roles de base de datos:
   * el consumidor aprovisiona el rol y fija su schema (p. ej. por `search_path`).
   */
  readonly databaseUrlSecret: secretsmanager.ISecret;
  /** Campo del secreto con la URL. Por defecto `url`. */
  readonly databaseUrlField?: string;
  /** El namespace se pasa explicito porque un cluster importado no trae el suyo. */
  readonly serviceConnect: { readonly namespace: string; readonly dnsName?: string };
  /** Security groups cuyos miembros pueden llamar al servicio (al menos uno), solo al puerto del servicio. */
  readonly ingressFrom: readonly ec2.ISecurityGroup[];
  /** Security groups adicionales del servicio (p. ej. el que da acceso a la base de datos). */
  readonly extraSecurityGroups?: readonly ec2.ISecurityGroup[];
  /** Se genera un secreto `{"<applicationId>": "<clave>"}`: la clave tecnica con la que un backend llama al servicio. */
  readonly appKey: { readonly applicationId: string };
  readonly environment: ServiceEnvironment;
  /** Puerto del contenedor. Por defecto 8000. */
  readonly port?: number;
  /** Ruta del health check (liveness). Por defecto `/api/v1/health`. */
  readonly healthCheckPath?: string;
  /** Comando de migracion que corre antes de arrancar. Por defecto `alembic upgrade head`. */
  readonly migrateCommand?: readonly string[];
  /** Comando de arranque. Por defecto `uvicorn app.main:app --host 0.0.0.0 --port <port>`. */
  readonly startCommand?: readonly string[];
  readonly sizing?: { readonly cpu?: number; readonly memoryMiB?: number; readonly startPeriodSeconds?: number };
  readonly logRetention?: logs.RetentionDays;
  /** Si se da, se crean las alarmas de CPU y memoria y avisan a este topico. */
  readonly alarmTopic?: sns.ITopic;
  /** Solo variables NO secretas. Las claves reservadas se rechazan. */
  readonly extraEnvVars?: Readonly<Record<string, string>>;
  /** Del secreto de clave y del log group. Por defecto RETAIN. */
  readonly removalPolicy?: cdk.RemovalPolicy;
}

/** Une los argumentos con espacios: `validateProps` ya garantizo que ninguno lleva metacaracteres de shell. */
const line = (argv: readonly string[]): string => argv.join(' ');

/**
 * Servicio HTTP privado en un cluster ECS Fargate existente: sin ALB, sin IP publica, alcanzable solo por Service Connect desde los security
 * groups autorizados. Secretos solo por Secrets Manager, task role sin permisos, imagen fijada por digest y migracion al arrancar.
 */
export class PrivateEcsService extends Construct {
  public readonly service: ecs.FargateService;
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly taskRole: iam.IRole;
  /** Secreto `{"<applicationId>": "<clave>"}` generado en cada instalacion. */
  public readonly appKeySecret: secretsmanager.Secret;
  public readonly applicationId: string;
  public readonly dnsName: string;
  /** `http://<dnsName>:<port>/api/v1`: la URL que usa un cliente dentro del namespace de Service Connect. */
  public readonly endpointUrl: string;

  constructor(scope: Construct, id: string, props: PrivateEcsServiceProps) {
    super(scope, id);

    const problems = validateProps(props);
    if (problems.length > 0) throw new Error(`PrivateEcsService "${id}": props invalidas:\n - ${problems.join('\n - ')}`);

    const port = props.port ?? DEFAULT_PORT;
    const healthPath = props.healthCheckPath ?? DEFAULT_HEALTH_PATH;
    const migrate = props.migrateCommand ?? DEFAULT_MIGRATE;
    const start = props.startCommand ?? ['uvicorn', 'app.main:app', '--host', '0.0.0.0', '--port', String(port)];
    const removalPolicy = props.removalPolicy ?? cdk.RemovalPolicy.RETAIN;
    this.applicationId = props.appKey.applicationId;
    this.dnsName = props.serviceConnect.dnsName ?? props.serviceName;
    this.endpointUrl = `http://${this.dnsName}:${port}${API_PREFIX}`;

    // --- Clave de aplicacion: el JSON {"<ID>": "<clave>"} es exactamente el formato de EMBEDDED_APPLICATIONS. ---
    this.appKeySecret = new secretsmanager.Secret(this, 'AppKey', {
      description: `Clave tecnica de aplicacion (${this.applicationId}) de ${props.serviceName}. Generada al desplegar; nunca en claro.`,
      generateSecretString: {
        secretStringTemplate: '{}',
        generateStringKey: this.applicationId,
        passwordLength: 64,
        excludePunctuation: true,
      },
      removalPolicy,
    });

    // --- Red: privada. Ingress solo desde los SG autorizados y solo al puerto del servicio. ---
    this.securityGroup = new ec2.SecurityGroup(this, 'ServiceSecurityGroup', {
      vpc: props.vpc,
      description: `${props.serviceName}: solo entran los security groups autorizados`,
      allowAllOutbound: true,
    });
    props.ingressFrom.forEach((source, i) => {
      this.securityGroup.addIngressRule(ec2.Peer.securityGroupId(source.securityGroupId), ec2.Port.tcp(port), `Cliente autorizado ${i + 1}`);
    });

    // --- Logs ---
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: props.logRetention ?? logs.RetentionDays.ONE_MONTH,
      removalPolicy,
    });

    // --- Task ---
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      cpu: props.sizing?.cpu ?? 512,
      memoryLimitMiB: props.sizing?.memoryMiB ?? 1024,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    // La imagen se fija por digest; `fromEcrRepository` solo acepta tag. El pull lo concede el execution role.
    props.image.repository.grantPull(taskDefinition.obtainExecutionRole());

    // Filesystem raiz de solo lectura: el unico directorio escribible es /tmp, como volumen efimero de la task (Fargate no tiene tmpfs).
    taskDefinition.addVolume({ name: TMP_VOLUME });
    const container = taskDefinition.addContainer('app', {
      containerName: 'app',
      image: ecs.ContainerImage.fromRegistry(`${props.image.repository.repositoryUri}@${props.image.digest}`),
      essential: true,
      portMappings: [{ name: 'http', containerPort: port, appProtocol: ecs.AppProtocol.http }],
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'app' }),
      // nextep-exception: EXC-ECS-MIGRATE-ON-START
      // La migracion corre en el entrypoint: con `minHealthyPercent 0` y `maxHealthyPercent 100` (abajo) nunca hay dos tasks migrando.
      command: ['sh', '-c', `${line(migrate)} && exec ${line(start)}`],
      // Python de la biblioteca estandar: las imagenes -slim no traen curl. `urlopen` lanza con un codigo que no es 2xx.
      healthCheck: {
        command: ['CMD-SHELL', `python -c "import urllib.request; urllib.request.urlopen('http://localhost:${port}${healthPath}', timeout=3)" || exit 1`],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(props.sizing?.startPeriodSeconds ?? 180),
      },
      stopTimeout: cdk.Duration.seconds(30),
      readonlyRootFilesystem: true,
      // Solo valores NO sensibles: los secretos van por `secrets`, nunca en `environment`.
      environment: {
        ...props.extraEnvVars,
        ENVIRONMENT: props.environment,
        ENGINE_VERSION: props.image.version,
        IMAGE_DIGEST: props.image.digest,
        PYTHONDONTWRITEBYTECODE: '1',
      },
      secrets: {
        DATABASE_URL: ecs.Secret.fromSecretsManager(props.databaseUrlSecret, props.databaseUrlField ?? 'url'),
        // El secreto ENTERO: ya es el JSON {"<ID>": "<clave>"} que espera EMBEDDED_APPLICATIONS.
        EMBEDDED_APPLICATIONS: ecs.Secret.fromSecretsManager(this.appKeySecret),
      },
    });
    container.addMountPoints({ containerPath: TMP_PATH, sourceVolume: TMP_VOLUME, readOnly: false });

    // El servicio no llama a AWS: el task role queda SIN statements (mínimo privilegio, guard L4).
    this.taskRole = taskDefinition.taskRole;

    // --- Servicio ---
    this.service = new ecs.FargateService(this, 'Service', {
      serviceName: props.serviceName,
      cluster: props.cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.securityGroup, ...(props.extraSecurityGroups ?? [])],
      // nextep-exception: EXC-ECS-MIGRATE-ON-START
      // Un deploy detiene la task vieja antes de arrancar la nueva: nunca dos tasks migrando a la vez (costo: un corte breve).
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { enable: true, rollback: true },
      enableExecuteCommand: false,
      enableECSManagedTags: true,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
      serviceConnectConfiguration: {
        namespace: props.serviceConnect.namespace,
        services: [{ portMappingName: 'http', dnsName: this.dnsName, port }],
        logDriver: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'service-connect' }),
      },
    });

    // --- Alarmas minimas (solo con un topico al que avisar) ---
    if (props.alarmTopic) {
      const action = new cloudwatchActions.SnsAction(props.alarmTopic);
      const five = cdk.Duration.minutes(5);
      const alarms: [string, cloudwatch.IMetric, string][] = [
        ['CpuHigh', this.service.metricCpuUtilization({ period: five }), 'CPU > 85 % durante 15 min'],
        ['MemoryHigh', this.service.metricMemoryUtilization({ period: five }), 'Memoria > 85 % durante 15 min'],
      ];
      for (const [alarmId, metric, description] of alarms) {
        new cloudwatch.Alarm(this, alarmId, {
          alarmDescription: `${props.serviceName}: ${description}`,
          metric,
          threshold: 85,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
          evaluationPeriods: 3,
          datapointsToAlarm: 3,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        }).addAlarmAction(action);
      }
    }
  }

  /** La clave de aplicacion lista para inyectarla (`secrets: { MI_VAR: svc.appKeyAsSecret() }`) en la task de un cliente. */
  public appKeyAsSecret(): ecs.Secret {
    return ecs.Secret.fromSecretsManager(this.appKeySecret, this.applicationId);
  }
}
