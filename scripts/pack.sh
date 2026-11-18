#!/usr/bin/env bash
# Empaqueta UN paquete de packages/* en un tarball listo para adjuntar a un Release de GitHub.
# Uso: bash scripts/pack.sh packages/cdk-guardrails
# Salida: release/<tarball>.tgz y release/<tarball>.tgz.sha256. No publica nada ni crea tags.
set -euo pipefail

pkg_dir="${1:?uso: pack.sh <packages/nombre>}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "$pkg_dir" in
  packages/*) ;;
  *) echo "pack.sh: el directorio debe estar bajo packages/ (recibido: $pkg_dir)" >&2; exit 2 ;;
esac
if [[ ! -f "$root/$pkg_dir/package.json" ]]; then
  echo "pack.sh: no existe $pkg_dir/package.json" >&2
  exit 2
fi

mkdir -p "$root/release"
# `npm pack` ejecuta `prepack` (tsc) y empaca SOLO lo declarado en "files".
tarball="$(cd "$root/$pkg_dir" && npm pack --pack-destination "$root/release" --silent | tail -n 1)"

(cd "$root/release" && sha256sum "$tarball" > "$tarball.sha256")
echo "tarball: release/$tarball"
echo "sha256:  $(cut -d' ' -f1 "$root/release/$tarball.sha256")"
