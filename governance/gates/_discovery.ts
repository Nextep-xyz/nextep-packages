import * as path from 'path';
import { discover as discoverIn, discoverDirs as discoverDirsIn, DiscoverOptions } from '@nextep/gates';

/** Raíz del repo (governance/gates/ → ../..). */
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

type RepoOptions = Omit<DiscoverOptions, 'cwd'> & { cwd?: string };

/** `discover` de @nextep/gates atado a la raíz de este repo. Descubre por disco; falla si hay menos de `min` sujetos. */
export const discover = (globs: string[], opts: RepoOptions): string[] => discoverIn(globs, { cwd: REPO_ROOT, ...opts });
export const discoverDirs = (globs: string[], opts: RepoOptions): string[] => discoverDirsIn(globs, { cwd: REPO_ROOT, ...opts });
