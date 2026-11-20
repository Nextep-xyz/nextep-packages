import * as fs from 'fs';
import * as path from 'path';
import { discover, discoverDirs, REPO_ROOT } from '@governance/gates/_discovery';
import { checkWorkflowCallers, WorkflowFile } from '@governance/lib/workflow-callers';

// GR14 — los workflows son CALLERS de los reusables de la plataforma, fijados por tag EXACTO, con disparadores y permisos minimos, y cada
// paquete de packages/* tiene exactamente un caller de release. Descubre por disco: un workflow o un paquete nuevo queda sujeto con solo aparecer.
// Spec: docs/specs/nextep-packages/SPEC.md §3 (GR14).

const PLATFORM = 'example-org/nextep-platform-workflows/.github/workflows';
const CI = (over: { ref?: string; perms?: string; extra?: string; on?: string } = {}): WorkflowFile => ({
  path: '.github/workflows/ci.yml',
  text: `name: ci
on:
${over.on ?? '  pull_request:\n  push:\n    branches: [main]'}
jobs:
  checks:
    permissions:
${over.perms ?? '      contents: read'}
    uses: ${PLATFORM}/lego-node-ci.yml@${over.ref ?? 'v1.5.1'}
    with:
      node-version: "22"
${over.extra ?? '    secrets:\n      INTERNAL_DENYLIST: ${{ secrets.INTERNAL_DENYLIST }}'}
`,
});
const REL = (pkg: string, over: { ref?: string; on?: string; perms?: string; prefix?: string; dir?: string; file?: string } = {}): WorkflowFile => ({
  path: over.file ?? `.github/workflows/release-${pkg}.yml`,
  text: `name: release-${pkg}
on:
${over.on ?? `  push:\n    tags: ["${pkg}-v*"]`}
jobs:
  release-${pkg}:
    permissions:
${over.perms ?? '      contents: write'}
    uses: ${PLATFORM}/lego-package-release.yml@${over.ref ?? 'v1.5.1'}
    with:
      package-dir: ${over.dir ?? `packages/${pkg}`}
      tag-prefix: ${over.prefix ?? `${pkg}-v`}
`,
});
const PKGS = ['alpha', 'beta'];
const GOOD = (): WorkflowFile[] => [CI(), REL('alpha'), REL('beta')];
const run = (files: WorkflowFile[], pkgs = PKGS): string => checkWorkflowCallers(files, pkgs).findings.join('\n');

describe('GR14 callers de la plataforma (unit): cada guard en rojo nombrando archivo y linea', () => {
  it('un juego correcto pasa', () => {
    expect(checkWorkflowCallers(GOOD(), PKGS).findings).toEqual([]);
  });

  it.each([
    ['@main', 'main'],
    ['una rama', 'feature-x'],
    ['un SHA', 'a'.repeat(40)],
    ['el alias movil @v1', 'v1'],
    ['un tag sin parche', 'v1.5'],
    ['un tag con sufijo', 'v1.5.1-rc1'],
  ])('rechaza %s', (_n, ref) => {
    const out = run([CI({ ref }), REL('alpha'), REL('beta')]);
    expect(out).toMatch(/^\.github\/workflows\/ci\.yml:\d+: ".*" no esta fijado por un tag EXACTO vX\.Y\.Z/);
    const out2 = run([CI(), REL('alpha', { ref }), REL('beta')]);
    expect(out2).toMatch(/\.github\/workflows\/release-alpha\.yml:\d+: ".*" no esta fijado por un tag EXACTO/);
  });

  it('`secrets: inherit` en cualquier caller', () => {
    expect(run([CI({ extra: '    secrets: inherit' }), REL('alpha'), REL('beta')])).toMatch(/ci\.yml:\d+: `secrets: inherit` esta prohibido/);
  });

  it('`pull_request_target` en cualquier caller (lista o mapa), pero no en un comentario', () => {
    expect(run([CI({ on: '  pull_request_target:' }), REL('alpha'), REL('beta')])).toMatch(/ci\.yml:\d+: `pull_request_target` esta prohibido/);
    expect(run([CI({ on: '  pull_request:\n  pull_request_target:' }), REL('alpha'), REL('beta')])).toMatch(/pull_request_target/);
    const commented = CI();
    commented.text = `# never pull_request_target, never secrets: inherit\n${commented.text}`;
    expect(run([commented, REL('alpha'), REL('beta')])).toBe('');
  });

  it.each([
    ['workflow_dispatch', '  workflow_dispatch:'],
    ['un pull_request junto a los tags', '  pull_request:\n  push:\n    tags: ["alpha-v*"]'],
    ['una rama junto a los tags', '  push:\n    branches: [main]\n    tags: ["alpha-v*"]'],
    ['un schedule', '  schedule:\n    - cron: "0 0 * * *"'],
  ])('un caller de release que dispara por %s', (_n, on) => {
    expect(run([CI(), REL('alpha', { on }), REL('beta')])).toMatch(/release-alpha\.yml:\d+: el caller de release "release-alpha" (dispara por|filtra|debe disparar)/);
  });

  it('un caller de release con push sin `tags` (dispararia en cada rama)', () => {
    expect(run([CI(), REL('alpha', { on: '  push:\n    branches: [main]' }), REL('beta')])).toMatch(/release-alpha\.yml:\d+: .*(filtra `push` por `branches`|debe disparar por `on.push.tags`)/);
  });

  it('un patron de tags que no cubre el tag-prefix (el release nunca dispararia)', () => {
    expect(run([CI(), REL('alpha', { on: '  push:\n    tags: ["other-v*"]' }), REL('beta')])).toMatch(/release-alpha\.yml:\d+: .* no incluye `alpha-v\*`/);
  });

  it.each([
    ['id-token en un release', '      contents: write\n      id-token: write', /release-alpha\.yml:\d+: el job "release-alpha" pide `id-token`/],
    ['permisos de mas en un release', '      contents: write\n      pull-requests: write', /release-alpha\.yml:\d+: el caller de release "release-alpha" pide `pull-requests`/],
    ['contents: read en un release', '      contents: read', /release-alpha\.yml:\d+: el caller de release "release-alpha" debe pedir `contents: write`/],
  ])('permisos de release: %s', (_n, perms, expected) => {
    expect(run([CI(), REL('alpha', { perms }), REL('beta')])).toMatch(expected);
  });

  it('un caller sin permisos explicitos', () => {
    const f = REL('alpha');
    f.text = f.text.replace(/ {4}permissions:\n {6}contents: write\n/, '');
    expect(run([CI(), f, REL('beta')])).toMatch(/release-alpha\.yml:\d+: el job "release-alpha" debe declarar `permissions:` explicitos/);
  });

  it.each([
    ['contents: write', '      contents: write', /ci\.yml:\d+: el caller de CI "checks" pide `contents: write`/],
    ['id-token', '      contents: read\n      id-token: write', /ci\.yml:\d+: el job "checks" pide `id-token`/],
    ['permisos de mas', '      contents: read\n      pull-requests: read', /ci\.yml:\d+: el caller de CI "checks" debe pedir exactamente `contents: read`/],
  ])('permisos del caller de CI: %s', (_n, perms, expected) => {
    expect(run([CI({ perms }), REL('alpha'), REL('beta')])).toMatch(expected);
  });

  it('un job que no es un caller de la plataforma (pipeline propio o reusable ajeno)', () => {
    const own: WorkflowFile = { path: '.github/workflows/own.yml', text: 'name: own\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n' };
    expect(run([...GOOD(), own])).toMatch(/own\.yml:\d+: el job "build" debe ser un caller/);
    const alien: WorkflowFile = { path: '.github/workflows/alien.yml', text: 'name: alien\non: push\njobs:\n  x:\n    uses: someone/else/.github/workflows/y.yml@v1.0.0\n' };
    expect(run([...GOOD(), alien])).toMatch(/alien\.yml:\d+: el job "x" usa "someone\/else.*": solo se admiten reusables/);
  });

  it('YAML invalido: falla nombrando el archivo', () => {
    expect(run([...GOOD(), { path: '.github/workflows/rota.yml', text: 'name: [sin cerrar\njobs: {' }])).toMatch(/rota\.yml:\d+: YAML invalido/);
  });

  describe('completitud: cada paquete de packages/* tiene exactamente un caller de release', () => {
    it('un paquete nuevo sin caller falla el build, nombrando el paquete', () => {
      expect(run(GOOD(), [...PKGS, 'gamma'])).toMatch(/^packages\/gamma: sin caller de release/m);
    });
    it('dos callers para el mismo paquete', () => {
      expect(run([...GOOD(), REL('alpha', { file: '.github/workflows/release-alpha-bis.yml' })])).toMatch(/^packages\/alpha: 2 callers de release/m);
    });
    it('tag-prefix que no es <dir>-v', () => {
      expect(run([CI(), REL('alpha', { prefix: 'a-v' }), REL('beta')])).toMatch(/release-alpha\.yml:\d+: .* debe declarar `tag-prefix: alpha-v` \(recibido: a-v\)/);
    });
    it('package-dir hacia un paquete inexistente (caller obsoleto)', () => {
      expect(run([...GOOD(), REL('zeta')])).toMatch(/release-zeta\.yml:\d+: .* apunta a packages\/zeta, que no existe en disco/);
    });
    it('package-dir con forma inesperada', () => {
      expect(run([CI(), REL('alpha', { dir: '.' }), REL('beta')])).toMatch(/release-alpha\.yml:\d+: .* debe declarar `package-dir: packages\/<dir>`/);
    });
  });
});

describe('GR14 callers de la plataforma (descubrimiento por disco)', () => {
  it('los workflows reales del repo cumplen GR14', () => {
    const paths = discover(['.github/workflows/*.yml', '.github/workflows/*.yaml'], { min: 3, dot: true });
    const files = paths.map((p) => ({ path: p, text: fs.readFileSync(path.join(REPO_ROOT, p), 'utf8') }));
    const pkgs = discoverDirs(['packages/*/package.json'], { min: 2 }).map((d) => path.posix.basename(d));
    const report = checkWorkflowCallers(files, pkgs);
    expect(report.findings).toEqual([]);
    // Un gate que no ve ni un caller de release no prueba la completitud.
    expect(report.releaseCallers.length).toBeGreaterThanOrEqual(pkgs.length);
  });
});
