#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Turn the merged store into an anvl-bench release asset. No Slurm: this reads
# the store and writes six Parquet files and a manifest, which is seconds to a
# couple of minutes even for a full grid -- fine on a login node.
#
#   ./export.sh                 export everything in the store
#   ./export.sh spec=nv_qnorm   export one function
#
# Produces ${SWEEP_ROOT}/dist/<ARTIFACT_ID>.zip, with the files at the zip's
# root (not inside a folder) -- which is the layout anvl-bench's release assets
# require. Copy it back and attach it to a Release; results never go into git.
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./config.sh

# Export exactly the backends that were swept. The harness's export used to
# default to anvl alone, which published a full anvl+JAX run with every JAX
# result missing; passing them explicitly works with any image, old or new.

require_sif

FILTER_ARG="${1:-${FILTER}}"
EXPORT_DIR="${SWEEP_ROOT}/export"
DIST="${SWEEP_ROOT}/dist"

rm -rf "${EXPORT_DIR}"
mkdir -p "${EXPORT_DIR}" "${DIST}" "${SWEEP_ROOT}/home" "${SWEEP_ROOT}/tmp"

"${SINGULARITY}" exec --cleanenv \
  --bind "${SWEEP_ROOT}:/sweeps" \
  --env "NV_SWEEP_STORE=/sweeps/store" \
  --env "HOME=/sweeps/home" \
  --env "TMPDIR=/sweeps/tmp" \
  "${SIF}" \
  anvl-sweep export --out /sweeps/export --backends "${BACKENDS}" \
    ${FILTER_ARG:+--filter "${FILTER_ARG}"}

echo "==> exported:"
ls -lh "${EXPORT_DIR}"

# The platform key the run actually recorded, straight out of the manifest --
# checked rather than assumed, because an artifact id that disagrees with the
# data inside it is how a CUDA run ends up merged into the CPU column.
MANIFEST_PLATFORM=$(grep -A 3 '"platforms"' "${EXPORT_DIR}/manifest.json" \
  | grep -o '"[a-z0-9_]*-[a-z0-9_]*-[a-z0-9]*"' | head -n 1 | tr -d '"' || true)
if [[ -n "${MANIFEST_PLATFORM}" && "${MANIFEST_PLATFORM}" != "${ARTIFACT_ID}" ]]; then
  echo "!! manifest says platform '${MANIFEST_PLATFORM}' but ARTIFACT_ID is '${ARTIFACT_ID}'" >&2
  echo "!! check config.sh before publishing this asset" >&2
fi

ZIP="${DIST}/${ARTIFACT_ID}.zip"
rm -f "${ZIP}"
( cd "${EXPORT_DIR}" && zip -q -r "${ZIP}" . -x '.*' )
echo "==> ${ZIP}"
unzip -l "${ZIP}"

cat <<NEXT

Copy it back and publish it:

  scp ${REMOTE_HOST}:${ZIP} .
  gh release upload <tag> ${ARTIFACT_ID}.zip     # in the anvl-bench repo
  # then point DEPLOY_RELEASE at <tag> and commit

NEXT
