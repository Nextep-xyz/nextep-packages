import { PrivateEcsService, RESERVED_ENV_KEYS, validateProps } from '../src';
import { build, DIGEST, minimalProps, newStack } from './helpers';

// Guards L1, L2 (applicationId), L3 (ingressFrom vacio) y L5: validacion de props. Cada caso en rojo nombra el campo culpable.

const BASE = { ...build().props };
const check = (over: Record<string, unknown>): string => validateProps({ ...BASE, ...over } as never).join('\n');

describe('props validas', () => {
  it('las props minimas no tienen problemas', () => {
    expect(validateProps(BASE as never)).toEqual([]);
  });
});

describe('L1: version exacta y digest sha256', () => {
  it.each([
    ['latest', 'latest'],
    ['sin parche', '1.4'],
    ['con rango ^', '^1.4.1'],
    ['con rango ~', '~1.4.1'],
    ['con prefijo v', 'v1.4.1'],
    ['vacia', ''],
  ])('rechaza la version %s', (_n, version) => {
    expect(check({ image: { ...BASE.image, version } })).toMatch(/image\.version: .* debe ser semver exacto/);
  });

  it.each([
    ['vacio', ''],
    ['sin prefijo sha256:', 'ab'.repeat(32)],
    ['corto', `sha256:${'ab'.repeat(31)}`],
    ['mayusculas', `sha256:${'AB'.repeat(32)}`],
    ['con un caracter que no es hex', `sha256:${'zz'.repeat(32)}`],
    ['un tag en lugar de digest', 'latest'],
  ])('rechaza el digest %s', (_n, digest) => {
    expect(check({ image: { ...BASE.image, digest } })).toMatch(/image\.digest: .* debe cumplir/);
  });

  it('acepta una version y un digest correctos, y una prerelease exacta', () => {
    expect(check({ image: { ...BASE.image, version: '1.4.1', digest: DIGEST } })).toBe('');
    expect(check({ image: { ...BASE.image, version: '1.4.1-rc.1' } })).toBe('');
  });

  it('el construct lanza (no sintetiza) con una version flotante', () => {
    const stack = newStack();
    const props = minimalProps(stack);
    expect(() => new PrivateEcsService(stack, 'Engine', { ...props, image: { ...props.image, version: '^1.0.0' } })).toThrow(/image\.version/);
  });
});

describe('L2: applicationId', () => {
  it.each(['demo', '1DEMO', 'DE MO', 'DEMO.X', '', 'A'.repeat(65)])('rechaza %j', (applicationId) => {
    expect(check({ appKey: { applicationId } })).toMatch(/appKey\.applicationId: .* no cumple/);
  });
  it('acepta un id valido', () => {
    expect(check({ appKey: { applicationId: 'MOTOR_1-A' } })).toBe('');
  });
});

describe('L3: el servicio es privado, ingressFrom es obligatorio', () => {
  it('vacio falla nombrando el campo', () => {
    expect(check({ ingressFrom: [] })).toMatch(/ingressFrom: debe tener al menos un security group/);
  });
  it('el construct lanza con ingressFrom vacio', () => {
    const stack = newStack();
    expect(() => new PrivateEcsService(stack, 'Engine', { ...minimalProps(stack), ingressFrom: [] })).toThrow(/ingressFrom/);
  });
});

describe('L5: claves reservadas de extraEnvVars', () => {
  it('la lista reservada cubre lo que el construct inyecta', () => {
    expect([...RESERVED_ENV_KEYS]).toEqual(expect.arrayContaining(['DATABASE_URL', 'EMBEDDED_APPLICATIONS', 'ENVIRONMENT', 'ENGINE_VERSION', 'IMAGE_DIGEST']));
  });

  // Una prueba por clave, descubierta de la propia lista: una clave nueva queda probada sin tocar este archivo.
  it.each([...RESERVED_ENV_KEYS])('rechaza %s', (key) => {
    expect(check({ extraEnvVars: { [key]: 'x' } })).toMatch(new RegExp(`extraEnvVars\\.${key}: clave reservada`));
  });

  it('rechaza una clave reservada en minusculas (sin trucos de mayusculas)', () => {
    expect(check({ extraEnvVars: { database_url: 'x' } })).toMatch(/extraEnvVars\.database_url: clave reservada/);
  });

  it('el construct lanza con una clave reservada', () => {
    const stack = newStack();
    expect(() => new PrivateEcsService(stack, 'Engine', { ...minimalProps(stack), extraEnvVars: { ENVIRONMENT: 'production' } })).toThrow(/extraEnvVars\.ENVIRONMENT/);
  });

  it('rechaza un nombre que no es de variable de entorno y acepta uno valido', () => {
    expect(check({ extraEnvVars: { 'BAD NAME': 'x' } })).toMatch(/no es un nombre de variable de entorno valido/);
    expect(check({ extraEnvVars: { LOG_LEVEL: 'info' } })).toBe('');
  });
});

describe('otras props', () => {
  it.each([
    ['serviceName con mayusculas', { serviceName: 'Demo' }, /serviceName/],
    ['serviceName de una letra', { serviceName: 'a' }, /serviceName/],
    ['environment desconocido', { environment: 'prod' }, /environment: "prod" debe ser uno de/],
    ['puerto fuera de rango', { port: 70000 }, /port: 70000/],
    ['puerto no entero', { port: 80.5 }, /port: 80\.5/],
    ['health check con comillas (inyeccion en el shell)', { healthCheckPath: "/x'); import os #" }, /healthCheckPath/],
    ['health check sin barra', { healthCheckPath: 'health' }, /healthCheckPath/],
    ['migrateCommand con metacaracteres de shell', { migrateCommand: ['alembic', 'upgrade', 'head;', 'rm'] }, /migrateCommand\[2\]: argumento invalido/],
    ['startCommand vacio', { startCommand: [] }, /startCommand: debe ser una lista no vacia/],
    ['startCommand con espacios', { startCommand: ['uvicorn app.main:app'] }, /startCommand\[0\]/],
    ['namespace vacio', { serviceConnect: { namespace: '' } }, /serviceConnect\.namespace/],
    ['dnsName con punto', { serviceConnect: { namespace: 'ns', dnsName: 'a.b' } }, /serviceConnect\.dnsName/],
    ['startPeriod mayor que el limite de ECS', { sizing: { startPeriodSeconds: 301 } }, /sizing\.startPeriodSeconds/],
    ['campo del secreto invalido', { databaseUrlField: 'a b' }, /databaseUrlField/],
  ])('%s', (_n, over, expected) => {
    expect(check(over)).toMatch(expected);
  });

  it('junta todos los problemas en un solo error', () => {
    const stack = newStack();
    const props = minimalProps(stack);
    expect(() => new PrivateEcsService(stack, 'Engine', { ...props, serviceName: 'X', appKey: { applicationId: 'x' } })).toThrow(/serviceName[\s\S]*appKey\.applicationId/);
  });
});
