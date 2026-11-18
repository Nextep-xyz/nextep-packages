import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { formatFindings, parseDenylist, scanPublic } from '@nextep/gates';

// Los valores "sensibles" se arman en tiempo de ejecucion: este archivo es parte de un repo publico y lo escanea el propio gate.
const ACCOUNT = '1'.repeat(12);
const PRIVATE_IP = ['10', '1', '2', '3'].join('.');
const CORP_EMAIL = ['dev', 'corp.test'].join('@');
const INTERNAL = 'zz' + 'internal' + 'name';
const CORP_HOST = ['internal', 'corp', 'test'].join('.');
const DOCS_HOST = ['docs', 'corp', 'test'].join('.');
const PLACEHOLDER_URLS = ['https://', '$', '{HOST}/x https://<host>/x "pattern": "https://[a-z]+/x"'].join('');

function repo(files: Record<string, string | Buffer>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-public-'));
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), content);
  }
  return dir;
}

const detectors = (root: string, extra: Partial<Parameters<typeof scanPublic>[0]> = {}): string[] =>
  scanPublic({ root, ...extra }).findings.map((f) => `${f.file}:${f.line}:${f.detector}`);

describe('scanPublic: detectores genericos, cada uno en rojo nombrando archivo y linea', () => {
  it('un repo limpio no tiene hallazgos', () => {
    const root = repo({ 'README.md': '# Titulo\nvisit https://github.com/example-org/shop and a@example.com\narn:aws:iam::<ACCOUNT>:role/x\n' });
    expect(scanPublic({ root }).findings).toEqual([]);
  });

  it.each([
    ['ID de cuenta', `const a = "${ACCOUNT}";`, /12-digit cloud account id/],
    ['ARN con cuenta', `arn:aws:iam::${ACCOUNT}:role/x`, /arn with a literal account id/],
    ['correo real', `contacto ${CORP_EMAIL}`, /email address/],
    ['IP privada', `host ${PRIVATE_IP}`, /private IP address/],
    ['URL fuera de la allowlist', `ver https://${CORP_HOST}/wiki`, /URL host outside the public allowlist/],
  ])('%s', (_n, text, expected) => {
    const root = repo({ 'ok.md': 'limpio', 'docs/malo.md': `linea 1\n${text}\n` });
    const out = detectors(root).join('\n');
    expect(out).toMatch(/docs\/malo\.md:2:/);
    expect(out).toMatch(expected);
    expect(out).not.toMatch(/ok\.md/);
  });

  it('nunca incluye el valor encontrado', () => {
    const root = repo({ 'a.md': `cuenta ${ACCOUNT} y ${CORP_EMAIL}` });
    const text = formatFindings(scanPublic({ root }).findings);
    expect(text).not.toContain(ACCOUNT);
    expect(text).not.toContain('corp.test');
  });

  it('una plantilla o un patron regex no es un host', () => {
    const root = repo({ 'a.md': PLACEHOLDER_URLS });
    expect(scanPublic({ root }).findings).toEqual([]);
  });

  it('allowedHosts propio reemplaza los defaults', () => {
    const root = repo({ 'a.md': `https://${DOCS_HOST}/x` });
    expect(detectors(root)).toHaveLength(1);
    expect(detectors(root, { allowedHosts: [DOCS_HOST.replace(/\./g, '\\.')] })).toEqual([]);
  });
});

describe('scanPublic: denylist de nombres internos', () => {
  it('detecta el nombre (insensible a mayusculas) y nombra archivo y linea', () => {
    const root = repo({ 'src/a.ts': `ok\n// ver ${INTERNAL.toUpperCase()}\n` });
    expect(detectors(root, { denylist: [INTERNAL] })).toEqual(['src/a.ts:2:internal name from INTERNAL_DENYLIST']);
  });

  it('sin denylist solo corren los detectores genericos', () => {
    const root = repo({ 'src/a.ts': `ver ${INTERNAL}` });
    const r = scanPublic({ root });
    expect(r.findings).toEqual([]);
    expect(r.denylistActive).toBe(false);
  });

  it('requireDenylist sin lista: lanza (CI no puede avalar a medias)', () => {
    expect(() => scanPublic({ root: repo({ 'a.md': 'x' }), requireDenylist: true })).toThrow(/INTERNAL_DENYLIST no esta configurada/);
  });

  it('parseDenylist acepta comas y saltos de linea y descarta vacios', () => {
    expect(parseDenylist(' a, b\nc\r\n,, ')).toEqual(['a', 'b', 'c']);
    expect(parseDenylist(undefined)).toEqual([]);
  });
});

describe('scanPublic: archivos generados excluidos por ruta exacta', () => {
  it('ignoreFiles excluye solo esa ruta; el resto se sigue escaneando', () => {
    const root = repo({ 'lock.yaml': `autor ${CORP_EMAIL}`, 'src/a.md': `contacto ${CORP_EMAIL}` });
    expect(detectors(root)).toHaveLength(2);
    expect(detectors(root, { ignoreFiles: ['lock.yaml'] })).toEqual(['src/a.md:1:email address']);
  });

  it('una exclusion obsoleta (la ruta no existe) lanza nombrandola', () => {
    expect(() => scanPublic({ root: repo({ 'a.md': 'x' }), ignoreFiles: ['lock.yaml'] })).toThrow(/ignoreFiles incluye "lock\.yaml"/);
  });
});

describe('scanPublic: un gate que no encuentra sujetos no prueba nada', () => {
  it('directorio vacio: lanza', () => {
    expect(() => scanPublic({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'gates-empty-')) })).toThrow(/0 archivos/);
  });
  it('solo binarios: lanza', () => {
    expect(() => scanPublic({ root: repo({ 'a.bin': Buffer.from([0, 1, 2, 3]) }) })).toThrow(/ninguno es texto/);
  });
  it('un binario con algo que parece cuenta se ignora; el texto vecino se escanea', () => {
    const root = repo({ 'a.bin': Buffer.concat([Buffer.from([0]), Buffer.from(ACCOUNT)]), 'b.md': 'limpio' });
    expect(scanPublic({ root }).scanned).toBe(1);
  });
});
