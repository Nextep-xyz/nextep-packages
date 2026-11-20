// Validacion pura de las props de PrivateEcsService (sin imports de CDK: se prueba sin sintetizar nada).
// Devuelve TODOS los problemas de una vez; el construct los junta en un solo error. Los guards L1, L2 y L5 del spec (P5) viven aqui.

export const ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export type ServiceEnvironment = (typeof ENVIRONMENTS)[number];

export const SERVICE_NAME = /^[a-z][a-z0-9-]{1,30}$/;
export const DNS_LABEL = /^[a-z][a-z0-9-]{0,62}$/;
/** Semver exacto: sin rangos, sin `v`, sin versiones parciales. */
export const EXACT_SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
export const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
export const APPLICATION_ID = /^[A-Z][A-Z0-9_-]{0,63}$/;
export const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_FIELD = /^[A-Za-z0-9_.-]{1,64}$/;
/** Argumento de un comando que se compone en una linea de shell: sin comillas, espacios ni metacaracteres. */
export const SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;
const HEALTH_PATH = /^\/[A-Za-z0-9_./-]*$/;

/** Variables que el construct inyecta: un consumidor no puede pisarlas con `extraEnvVars` (guard L5). */
export const RESERVED_ENV_KEYS = [
  'DATABASE_URL',
  'EMBEDDED_APPLICATIONS',
  'ENVIRONMENT',
  'ENGINE_VERSION',
  'IMAGE_DIGEST',
  'PYTHONDONTWRITEBYTECODE',
] as const;

export interface ValidatableProps {
  serviceName: string;
  image: { version: string; digest: string };
  appKey: { applicationId: string };
  environment: string;
  ingressFrom: readonly unknown[];
  databaseUrlField?: string;
  serviceConnect: { namespace: string; dnsName?: string };
  port?: number;
  healthCheckPath?: string;
  migrateCommand?: readonly string[];
  startCommand?: readonly string[];
  sizing?: { startPeriodSeconds?: number };
  extraEnvVars?: Readonly<Record<string, string>>;
}

function checkCommand(label: string, cmd: readonly string[] | undefined, out: string[]): void {
  if (cmd === undefined) return;
  if (!Array.isArray(cmd) || cmd.length === 0) {
    out.push(`${label}: debe ser una lista no vacia de argumentos`);
    return;
  }
  cmd.forEach((arg, i) => {
    if (typeof arg !== 'string' || !SAFE_ARG.test(arg)) {
      out.push(`${label}[${i}]: argumento invalido ${JSON.stringify(arg)} (solo ${String(SAFE_ARG)}: el comando se compone en una linea de shell)`);
    }
  });
}

export function validateProps(p: ValidatableProps): string[] {
  const out: string[] = [];

  if (!SERVICE_NAME.test(p.serviceName ?? '')) out.push(`serviceName: ${JSON.stringify(p.serviceName)} no cumple ${String(SERVICE_NAME)}`);

  // L1: la imagen se fija por version exacta y digest; nada de `latest`, rangos ni digests mal formados.
  if (!EXACT_SEMVER.test(p.image?.version ?? '')) out.push(`image.version: ${JSON.stringify(p.image?.version)} debe ser semver exacto X.Y.Z (sin latest, rangos ni prefijo v)`);
  if (!IMAGE_DIGEST.test(p.image?.digest ?? '')) out.push(`image.digest: ${JSON.stringify(p.image?.digest)} debe cumplir ${String(IMAGE_DIGEST)}`);

  // L2: la clave de aplicacion es el id del secreto generado y el nombre de la clave del JSON.
  if (!APPLICATION_ID.test(p.appKey?.applicationId ?? '')) out.push(`appKey.applicationId: ${JSON.stringify(p.appKey?.applicationId)} no cumple ${String(APPLICATION_ID)}`);

  if (!(ENVIRONMENTS as readonly string[]).includes(p.environment)) out.push(`environment: ${JSON.stringify(p.environment)} debe ser uno de ${ENVIRONMENTS.join(', ')}`);

  // L3: sin clientes autorizados el servicio quedaria inalcanzable (o, peor, se tentaria a abrirlo).
  if (!Array.isArray(p.ingressFrom) || p.ingressFrom.length === 0) out.push('ingressFrom: debe tener al menos un security group de origen (el servicio es privado)');

  if (p.databaseUrlField !== undefined && !SECRET_FIELD.test(p.databaseUrlField)) out.push(`databaseUrlField: ${JSON.stringify(p.databaseUrlField)} no cumple ${String(SECRET_FIELD)}`);

  if (!p.serviceConnect?.namespace) out.push('serviceConnect.namespace: es obligatorio (un cluster importado no trae su namespace)');
  const dns = p.serviceConnect?.dnsName;
  if (dns !== undefined && !DNS_LABEL.test(dns)) out.push(`serviceConnect.dnsName: ${JSON.stringify(dns)} debe ser una sola etiqueta DNS (${String(DNS_LABEL)})`);

  if (p.port !== undefined && !(Number.isInteger(p.port) && p.port >= 1 && p.port <= 65535)) out.push(`port: ${String(p.port)} debe ser un entero entre 1 y 65535`);
  if (p.healthCheckPath !== undefined && !HEALTH_PATH.test(p.healthCheckPath)) out.push(`healthCheckPath: ${JSON.stringify(p.healthCheckPath)} debe empezar por "/" y no llevar comillas ni espacios`);
  checkCommand('migrateCommand', p.migrateCommand, out);
  checkCommand('startCommand', p.startCommand, out);

  const start = p.sizing?.startPeriodSeconds;
  if (start !== undefined && !(Number.isInteger(start) && start >= 0 && start <= 300)) out.push(`sizing.startPeriodSeconds: ${String(start)} debe ser un entero entre 0 y 300 (limite de ECS)`);

  // L5: las variables que inyecta el construct no se pisan; el resto debe ser un nombre de variable valido.
  for (const key of Object.keys(p.extraEnvVars ?? {})) {
    if ((RESERVED_ENV_KEYS as readonly string[]).includes(key.toUpperCase())) out.push(`extraEnvVars.${key}: clave reservada (la inyecta el construct)`);
    else if (!ENV_VAR_NAME.test(key)) out.push(`extraEnvVars.${key}: no es un nombre de variable de entorno valido`);
  }

  return out;
}
