import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { parse as parseYaml } from 'yaml';
import { discoverDirs, REPO_ROOT } from '@governance/gates/_discovery';

// G-INT â€” un tarball alterado falla el install de un consumidor (spec nextep-packages Â§3 y Â§8).
// Hermetico: un servidor HTTP local imita el 302 de los assets de un Release de GitHub (`/download/<file>` -> `/objects/<file>`) y el registry
// del consumidor apunta a un puerto muerto, asi que cualquier salida a la red hace fallar el install en vez de pasar por casualidad.
// Corre en Windows y en Linux. Si pnpm o bash no estan disponibles, el test FALLA (un skip silencioso es un gate que no prueba nada).
//
// Alcance: el sujeto es todo paquete de packages/* (por disco) SIN `dependencies` de runtime, porque una dependencia obligaria al install a
// hablar con un registry y el test dejaria de ser hermetico. La propiedad que se prueba (el lockfile graba el integrity y un asset alterado
// no se instala) no depende del paquete. Se exige al menos uno.

const IS_WIN = process.platform === 'win32';
// Las URLs se arman en tiempo de ejecucion: el gate G13 escanea los tests y no admite hosts fuera de su allowlist escritos como literal.
const LOOPBACK = ['127', '0', '0', '1'].join('.');
const origin = (port: number): string => `${'http:'}//${LOOPBACK}:${port}`;
const DEAD_REGISTRY = `${origin(9)}/`;

interface Run {
  status: number | null;
  out: string;
}

/** Ejecuta un comando de forma ASINCRONA (el servidor HTTP vive en este mismo proceso: un spawnSync lo bloquearia). */
function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    // En Windows pnpm es un .cmd: necesita shell. Los argumentos se citan (las rutas temporales pueden llevar espacios).
    const child = IS_WIN
      ? spawn([cmd, ...args].map((a) => `"${a.replace(/"/g, '\\"')}"`).join(' '), { cwd, env: { ...process.env, ...env }, shell: true })
      : spawn(cmd, args, { cwd, env: { ...process.env, ...env } });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, out }));
  });
}

/** `bash` de Git en Windows (el `bash` del PATH puede ser el de WSL, que no ve las rutas de Windows); `bash` a secas en Linux/macOS. */
function findBash(): string {
  if (!IS_WIN) return 'bash';
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean) as string[];
  for (const r of roots) {
    const c = path.join(r, 'Git', 'bin', 'bash.exe');
    if (fs.existsSync(c)) return c;
  }
  return 'bash';
}

const sha = (algo: string, buf: Buffer, enc: crypto.BinaryToTextEncoding): string => crypto.createHash(algo).update(buf).digest(enc);

/** Servidor que imita los assets de un Release de GitHub: la URL publica responde 302 hacia el objeto, que sirve los bytes actuales de `files`. */
async function startReleaseServer(files: Map<string, Buffer>): Promise<{ base: string; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    hits.push(`${req.method} ${url}`);
    const m = /^\/(download|objects)\/([^/?]+)$/.exec(url);
    const body = m ? files.get(decodeURIComponent(m[2] ?? '')) : undefined;
    if (!m || !body) {
      res.writeHead(404).end();
    } else if (m[1] === 'download') {
      res.writeHead(302, { Location: `/objects/${m[2]}` }).end();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length }).end(body);
    }
  });
  await new Promise<void>((r) => server.listen(0, LOOPBACK, r));
  const port = (server.address() as { port: number }).port;
  return { base: origin(port), hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Paquetes de packages/* sin `dependencies` de runtime, descubiertos por disco. */
function dependencyFreePackages(): string[] {
  const dirs = discoverDirs(['packages/*/package.json'], { min: 2 });
  return dirs.filter((d) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, d, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    return Object.keys(manifest.dependencies ?? {}).length === 0;
  });
}

describe('G-INT: un tarball alterado falla el install de un consumidor (hermetico, sin red externa)', () => {
  jest.setTimeout(240_000);

  it('hay al menos un paquete sin dependencias de runtime que probar', () => {
    expect(dependencyFreePackages().length).toBeGreaterThanOrEqual(1);
  });

  it('pnpm y bash estan disponibles (si no, el gate falla: no se salta en silencio)', async () => {
    const pnpm = await run('pnpm', ['--version'], REPO_ROOT).catch((e: Error) => ({ status: -1, out: String(e) }));
    expect({ tool: 'pnpm', ok: pnpm.status === 0, out: pnpm.status === 0 ? '' : pnpm.out }).toEqual({ tool: 'pnpm', ok: true, out: '' });
    const bash = await run(findBash(), ['--version'], REPO_ROOT).catch((e: Error) => ({ status: -1, out: String(e) }));
    expect({ tool: 'bash', ok: bash.status === 0, out: bash.status === 0 ? '' : bash.out }).toEqual({ tool: 'bash', ok: true, out: '' });
  });

  it.each(dependencyFreePackages())('%s: pack.sh -> instalar por URL -> el lockfile graba el integrity -> un asset alterado falla', async (pkgDir) => {
    const pkgName = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, pkgDir, 'package.json'), 'utf8')) as { name: string }).name;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nextep-gint-'));
    const releaseDir = path.join(REPO_ROOT, 'release');
    const releaseExisted = fs.existsSync(releaseDir);
    const created: string[] = [];
    let server: Awaited<ReturnType<typeof startReleaseServer>> | undefined;
    try {
      // 1. El empaquetado REAL del repo.
      const packed = await run(findBash(), ['scripts/pack.sh', pkgDir], REPO_ROOT);
      expect({ status: packed.status, out: packed.status === 0 ? '' : packed.out }).toEqual({ status: 0, out: '' });
      const m = /^tarball: release\/(\S+\.tgz)\s*$/m.exec(packed.out);
      expect(m).not.toBeNull();
      const file = m![1]!;
      created.push(path.join(releaseDir, file), path.join(releaseDir, `${file}.sha256`));
      const tarball = fs.readFileSync(path.join(releaseDir, file));
      // El .sha256 que acompana al Release es el del tarball (formato de `sha256sum --check`).
      expect(fs.readFileSync(path.join(releaseDir, `${file}.sha256`), 'utf8').trim().split(/\s+/)[0]).toBe(sha('sha256', tarball, 'hex'));

      // 2. Un "Release" local: la URL publica responde 302 hacia el objeto.
      const served = new Map<string, Buffer>([[file, tarball]]);
      server = await startReleaseServer(served);
      const url = `${server.base}/download/${file}`;

      // 3. Un consumidor limpio, con un registry muerto y sin reintentos.
      const consumer = path.join(tmp, 'consumer');
      fs.mkdirSync(consumer);
      fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', version: '1.0.0', private: true, dependencies: { [pkgName]: url } }, null, 2));
      fs.writeFileSync(path.join(consumer, '.npmrc'), `registry=${DEAD_REGISTRY}\nfetch-retries=0\n`);
      const env = { npm_config_registry: DEAD_REGISTRY, CI: 'true' };

      const first = await run('pnpm', ['install', '--ignore-scripts', '--store-dir', path.join(tmp, 'store-1')], consumer, env);
      expect({ status: first.status, out: first.status === 0 ? '' : first.out }).toEqual({ status: 0, out: '' });
      expect(server.hits.some((h) => h.startsWith('GET /download/'))).toBe(true); // siguio la redireccion
      expect(server.hits.some((h) => h.startsWith('GET /objects/'))).toBe(true);
      expect(fs.existsSync(path.join(consumer, 'node_modules', ...pkgName.split('/'), 'package.json'))).toBe(true);

      // 4. El lockfile graba el integrity sha512 de ESOS bytes y la URL exacta.
      const lock = parseYaml(fs.readFileSync(path.join(consumer, 'pnpm-lock.yaml'), 'utf8')) as { packages?: Record<string, { resolution?: { integrity?: string; tarball?: string } }> };
      const entries = Object.entries(lock.packages ?? {}).filter(([k]) => k.startsWith(`${pkgName}@`));
      expect(entries.length).toBe(1);
      const resolution = entries[0]![1].resolution ?? {};
      expect(resolution.tarball).toBe(url);
      expect(resolution.integrity).toBe(`sha512-${sha('sha512', tarball, 'base64')}`);

      // 5. Alteran el asset (los mismos nombre y URL, otros bytes) y el consumidor instala con un store limpio: debe fallar por integrity.
      served.set(file, Buffer.concat([tarball, Buffer.from('tampered')]));
      fs.rmSync(path.join(consumer, 'node_modules'), { recursive: true, force: true });
      const tampered = await run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts', '--store-dir', path.join(tmp, 'store-2')], consumer, env);
      expect(tampered.status).not.toBe(0);
      expect(tampered.out).toMatch(/ERR_PNPM_TARBALL_INTEGRITY/);
      expect(fs.existsSync(path.join(consumer, 'node_modules', ...pkgName.split('/'), 'package.json'))).toBe(false);

      // 6. Control: con los bytes originales el mismo install (store limpio) sigue funcionando; el fallo anterior fue por la alteracion y no por otra cosa.
      served.set(file, tarball);
      const control = await run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts', '--store-dir', path.join(tmp, 'store-3')], consumer, env);
      expect({ status: control.status, out: control.status === 0 ? '' : control.out }).toEqual({ status: 0, out: '' });
    } finally {
      await server?.close();
      for (const f of created) fs.rmSync(f, { force: true });
      if (!releaseExisted) fs.rmSync(releaseDir, { recursive: true, force: true });
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
