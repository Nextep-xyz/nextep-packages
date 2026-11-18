import type { ExceptionEntry } from '../types';

/** Clave de Metadata con la que un recurso declara una excepción en el propio template (spec §2.4, mitad «código»). */
export const EXCEPTION_METADATA_KEY = 'nextep:exception';

/** La marca acepta un string suelto o una lista de ids de regla. */
export const markIds = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);

/** Vigente hasta el final del día de `expires` (UTC). */
export const isActive = (e: ExceptionEntry, now: Date): boolean => {
  const end = new Date(`${e.expires}T23:59:59.999Z`);
  return !Number.isNaN(end.getTime()) && end.getTime() >= now.getTime();
};
