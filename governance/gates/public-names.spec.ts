import { formatFindings, parseDenylist, scanPublic } from '@nextep/gates';
import { REPO_ROOT } from '@governance/gates/_discovery';

// G13 (misma regla que el gate G13 de nextep-platform-workflows): este repositorio es PUBLICO. Nada de nombres internos, cuentas, dominios,
// correos ni IPs privadas, en ningun archivo versionado o por versionar (git ls-files -co --exclude-standard).
//
// La denylist de nombres internos NO vive en el repo (listarla aqui filtraria justo lo que protege): llega por entorno, como secreto de la
// organizacion en CI (`INTERNAL_DENYLIST`, separada por comas o saltos de linea). En CI el gate FALLA si falta; en un PR de un fork (sin
// acceso a secretos, GATE_FORK_PR=true) y en local corren solo los detectores genericos y se avisa.

const inCi = process.env.CI === 'true' && process.env.GATE_FORK_PR !== 'true';
const denylist = parseDenylist(process.env.INTERNAL_DENYLIST);

describe('G13: el repositorio no contiene nombres internos, cuentas, correos, IPs privadas ni hosts ajenos', () => {
  if (denylist.length === 0 && !inCi) {
    // eslint-disable-next-line no-console
    console.warn('G13: INTERNAL_DENYLIST no esta definida; corren solo los detectores genericos (en CI es obligatoria)');
  }

  it('el escaner descubre sujetos y no encuentra nada', () => {
    // pnpm-lock.yaml es metadata GENERADA de paquetes de terceros (correos de autores, nombres de mantenedores): no la escribimos nosotros.
    // Es la unica exclusion; si el lockfile deja de existir, el escaner lo reporta como exclusion obsoleta.
    const result = scanPublic({ root: REPO_ROOT, denylist, requireDenylist: inCi, ignoreFiles: ['pnpm-lock.yaml'] });
    // Un gate que no encuentra sujetos no prueba nada: este repo tiene muchas decenas de archivos de texto.
    expect(result.scanned).toBeGreaterThan(50);
    expect(formatFindings(result.findings)).toBe('');
  });
});
