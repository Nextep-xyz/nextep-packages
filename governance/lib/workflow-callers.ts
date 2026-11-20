// Logica pura del gate GR14 (spec nextep-packages, §3): los workflows de este repo son CALLERS de pocas lineas de los reusables de la plataforma.
// El gate (governance/gates/workflow-callers.spec.ts) descubre `.github/workflows/*.yml` y `packages/*` por disco y arma las entradas; aqui solo se juzga.
// Se parsea el YAML de verdad (no se busca con regex): un comentario que nombra `pull_request_target` no es un disparador.

import { isMap, isScalar, isSeq, LineCounter, parseDocument, visit, Document, Node, Pair, YAMLMap } from 'yaml';

export interface WorkflowFile {
  /** Ruta relativa a la raiz, con `/` (p. ej. `.github/workflows/ci.yml`). */
  path: string;
  text: string;
}

/** Repositorio de la plataforma, sin la organizacion (se compara sin distinguir mayusculas y con cualquier owner: un fork o un typo tambien se juzga). */
const PLATFORM_REPO = 'nextep-platform-workflows';
const PLATFORM_USES = new RegExp(`^[^/@\\s]+/${PLATFORM_REPO}/\\.github/workflows/([A-Za-z0-9_.-]+\\.ya?ml)@(.+)$`, 'i');
const EXACT_TAG = /^v\d+\.\d+\.\d+$/;
const RELEASE_WORKFLOW = 'lego-package-release.yml';
const CI_WORKFLOW = 'lego-node-ci.yml';

type Finding = { line: number; msg: string };

const keyOf = (p: Pair): string | undefined => (isScalar(p.key) && typeof p.key.value === 'string' ? p.key.value : undefined);
const pairOf = (map: YAMLMap | null | undefined, key: string): Pair | undefined => (map ? (map.items.find((p) => keyOf(p) === key) as Pair | undefined) : undefined);
const asMap = (n: unknown): YAMLMap | undefined => (isMap(n) ? n : undefined);
const scalarStr = (n: unknown): string | undefined => (isScalar(n) && n.value !== null && n.value !== undefined ? String(n.value) : undefined);

/** Disparadores declarados en `on:` (cadena, lista o mapa), con el nodo donde se declaran. */
function triggers(on: Node | null | undefined): { name: string; node: Node | null }[] {
  if (isScalar(on)) return [{ name: String(on.value), node: on }];
  if (isSeq(on)) return on.items.map((i) => ({ name: String(isScalar(i) ? i.value : ''), node: i as Node }));
  if (isMap(on)) return on.items.map((p) => ({ name: keyOf(p) ?? '', node: p.key as Node }));
  return [];
}

export interface ReleaseCaller {
  file: string;
  jobId: string;
  line: number;
  packageDir?: string;
  tagPrefix?: string;
}

export interface CallerReport {
  /** `<ruta>:<linea>: <mensaje>` */
  findings: string[];
  releaseCallers: ReleaseCaller[];
}

/** Juzga UN workflow. */
function checkOne(file: WorkflowFile): { findings: Finding[]; releases: ReleaseCaller[]; lc: LineCounter } {
  const lc = new LineCounter();
  const findings: Finding[] = [];
  const releases: ReleaseCaller[] = [];
  const doc: Document.Parsed = parseDocument(file.text, { lineCounter: lc });
  const lineAt = (n: Node | null | undefined): number => (n?.range ? lc.linePos(n.range[0]).line : 1);
  const add = (n: Node | null | undefined, msg: string): void => void findings.push({ line: lineAt(n), msg });

  if (doc.errors.length > 0) {
    const err = doc.errors[0]!;
    findings.push({ line: err.linePos?.[0].line ?? 1, msg: `YAML invalido: ${err.message.split('\n')[0]}` });
    return { findings, releases, lc };
  }
  const root = asMap(doc.contents);
  if (!root) {
    findings.push({ line: 1, msg: 'el workflow debe ser un mapa YAML' });
    return { findings, releases, lc };
  }

  // Invariantes de TODO caller, esten donde esten en el documento.
  visit(doc, {
    Pair(_k, pair) {
      if (keyOf(pair) === 'secrets' && scalarStr(pair.value)?.trim() === 'inherit') {
        add(pair.key as Node, '`secrets: inherit` esta prohibido: los secretos se pasan por nombre (el workflow declara cuales acepta)');
      }
    },
  });
  const onPair = pairOf(root, 'on');
  const trig = triggers(onPair?.value as Node | undefined);
  for (const t of trig) {
    if (t.name === 'pull_request_target') add(t.node, '`pull_request_target` esta prohibido: ejecutaria el codigo de un PR con los permisos de la base');
  }
  const topPerms = pairOf(root, 'permissions');
  if (topPerms && isMap(topPerms.value) && pairOf(topPerms.value, 'id-token')) add(topPerms.key as Node, '`id-token` esta prohibido: ningun caller de este repo asume un rol cloud');

  const jobs = asMap(pairOf(root, 'jobs')?.value);
  if (!jobs || jobs.items.length === 0) {
    findings.push({ line: 1, msg: 'el workflow no declara jobs' });
    return { findings, releases, lc };
  }

  for (const jobPair of jobs.items) {
    const jobId = keyOf(jobPair) ?? '?';
    const job = asMap(jobPair.value);
    if (!job) continue;
    const usesPair = pairOf(job, 'uses');
    const uses = scalarStr(usesPair?.value);
    if (!usesPair || !uses) {
      add(jobPair.key as Node, `el job "${jobId}" debe ser un caller (\`uses:\` hacia un reusable de ${PLATFORM_REPO}); aqui no se escriben pipelines propios`);
      continue;
    }
    const m = PLATFORM_USES.exec(uses);
    if (!m) {
      add(usesPair.value as Node, `el job "${jobId}" usa "${uses}": solo se admiten reusables de ${PLATFORM_REPO}`);
      continue;
    }
    const workflowFile = m[1] ?? '';
    const ref = m[2] ?? '';
    if (!EXACT_TAG.test(ref)) {
      add(usesPair.value as Node, `"${uses}" no esta fijado por un tag EXACTO vX.Y.Z (recibido "@${ref}"; no se admiten ramas, SHAs ni el alias movil @v1)`);
    }

    // Permisos del job: explicitos y minimos. Nunca id-token.
    const permsPair = pairOf(job, 'permissions');
    const perms = asMap(permsPair?.value);
    if (!permsPair || !perms) {
      add(jobPair.key as Node, `el job "${jobId}" debe declarar \`permissions:\` explicitos`);
    } else if (pairOf(perms, 'id-token')) {
      add(pairOf(perms, 'id-token')!.key as Node, `el job "${jobId}" pide \`id-token\`: ningun caller de este repo asume un rol cloud`);
    }
    const permValue = (k: string): string | undefined => scalarStr(pairOf(perms, k)?.value);
    const permKeys = perms ? perms.items.map((p) => keyOf(p) ?? '?') : [];

    if (workflowFile === CI_WORKFLOW) {
      for (const k of permKeys) {
        if (k !== 'id-token' && permValue(k) === 'write') add(pairOf(perms, k)!.key as Node, `el caller de CI "${jobId}" pide \`${k}: write\`: el CI solo lee (\`contents: read\`)`);
      }
      if (perms && !(permKeys.length === 1 && permValue('contents') === 'read') && !permKeys.includes('id-token') && !permKeys.some((k) => permValue(k) === 'write')) {
        add(permsPair!.key as Node, `el caller de CI "${jobId}" debe pedir exactamente \`contents: read\` (pide: ${permKeys.join(', ') || 'nada'})`);
      }
    }

    if (workflowFile === RELEASE_WORKFLOW) {
      // Disparador: SOLO push de tags. Quien puede empujar el tag inicia el release; cualquier otro disparador lo abre a otra puerta.
      const onMap = asMap(onPair?.value);
      const pushPair = pairOf(onMap, 'push');
      const pushMap = asMap(pushPair?.value);
      const others = trig.filter((t) => t.name !== 'push');
      for (const t of others) add(t.node, `el caller de release "${jobId}" dispara por \`${t.name}\`: solo \`push.tags\` (la barrera es el ruleset de tags)`);
      if (!onMap || !pushPair || !pushMap) {
        add((onPair?.key as Node) ?? (jobPair.key as Node), `el caller de release "${jobId}" debe disparar por \`on.push.tags\``);
      } else {
        for (const p of pushMap.items) {
          if (keyOf(p) !== 'tags') add(p.key as Node, `el caller de release "${jobId}" filtra \`push\` por \`${keyOf(p)}\`: solo \`tags\``);
        }
        if (!pairOf(pushMap, 'tags')) add(pushPair.key as Node, `el caller de release "${jobId}" debe disparar por \`on.push.tags\` (sin \`tags\`, \`push\` dispararia en cada rama)`);
      }
      // Permisos: exactamente `contents: write`, nada mas.
      if (perms) {
        for (const k of permKeys) {
          if (k !== 'contents' && k !== 'id-token') add(pairOf(perms, k)!.key as Node, `el caller de release "${jobId}" pide \`${k}\`: solo \`contents: write\``);
        }
        if (permValue('contents') !== 'write') add(permsPair!.key as Node, `el caller de release "${jobId}" debe pedir \`contents: write\` (el job \`release\` del reusable lo necesita)`);
      }
      const withMap = asMap(pairOf(job, 'with')?.value);
      const tagPrefix = scalarStr(pairOf(withMap, 'tag-prefix')?.value);
      const packageDir = scalarStr(pairOf(withMap, 'package-dir')?.value);
      releases.push({ file: file.path, jobId, line: lineAt(jobPair.key as Node), packageDir, tagPrefix });
      // El patron de tags del disparador debe cubrir el prefijo: si no, el release nunca dispara y nadie se entera.
      const tagsNode = pairOf(pushMap, 'tags')?.value;
      if (tagPrefix && isSeq(tagsNode)) {
        const patterns = tagsNode.items.map((i) => scalarStr(i)).filter((s): s is string => !!s);
        if (!patterns.includes(`${tagPrefix}*`)) {
          add(tagsNode as Node, `el caller de release "${jobId}": \`on.push.tags\` (${patterns.join(', ') || 'vacio'}) no incluye \`${tagPrefix}*\`: el release nunca se dispararia`);
        }
      }
    }
  }
  return { findings, releases, lc };
}

/**
 * Juzga todos los callers y la invariante de completitud: cada paquete de `packages/*` tiene EXACTAMENTE un caller de release con
 * `tag-prefix: <dir>-v` y `package-dir: packages/<dir>`. `packageNames` son los nombres de directorio (por disco), no rutas.
 */
export function checkWorkflowCallers(files: WorkflowFile[], packageNames: string[]): CallerReport {
  const out: string[] = [];
  const releaseCallers: ReleaseCaller[] = [];
  for (const f of files) {
    const r = checkOne(f);
    for (const fi of r.findings) out.push(`${f.path}:${fi.line}: ${fi.msg}`);
    releaseCallers.push(...r.releases);
  }

  const known = new Set(packageNames);
  for (const rc of releaseCallers) {
    const where = `${rc.file}:${rc.line}`;
    const m = rc.packageDir ? /^packages\/([^/]+)$/.exec(rc.packageDir) : null;
    if (!m) {
      out.push(`${where}: el caller de release "${rc.jobId}" debe declarar \`package-dir: packages/<dir>\` (recibido: ${rc.packageDir ?? 'nada'})`);
      continue;
    }
    const dir = m[1] ?? '';
    if (!known.has(dir)) out.push(`${where}: el caller de release "${rc.jobId}" apunta a ${rc.packageDir}, que no existe en disco (caller obsoleto)`);
    if (rc.tagPrefix !== `${dir}-v`) out.push(`${where}: el caller de release "${rc.jobId}" debe declarar \`tag-prefix: ${dir}-v\` (recibido: ${rc.tagPrefix ?? 'nada'})`);
  }
  for (const name of [...known].sort()) {
    const callers = releaseCallers.filter((rc) => rc.packageDir === `packages/${name}`);
    if (callers.length === 0) out.push(`packages/${name}: sin caller de release en .github/workflows/ (cada paquete necesita uno con \`package-dir: packages/${name}\` y \`tag-prefix: ${name}-v\`)`);
    if (callers.length > 1) out.push(`packages/${name}: ${callers.length} callers de release (${callers.map((c) => `${c.file}:${c.line}`).join(', ')}); debe haber exactamente uno`);
  }
  return { findings: out, releaseCallers };
}
