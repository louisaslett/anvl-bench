#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Build the sweep image for the cluster's architecture, and get it there.
#
#   ./build.sh build     docker buildx, linux/amd64
#   ./build.sh save      docker save -> dist/<image>-<tag>.tar.gz
#   ./build.sh ship      scp the tarball to the cluster            [STUB]
#   ./build.sh sif       build the .sif over ssh on the cluster    [STUB]
#   ./build.sh all       all four, in order
#
# The three steps after `build` are stubs in the sense that the *host and paths*
# they act on are placeholders in config.sh -- the commands themselves are real
# and will work once REMOTE_HOST / REMOTE_DIR are yours.
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./config.sh

IMAGE="${IMAGE_NAME}:${IMAGE_TAG}"

echo "image: ${IMAGE}   sif: ${SIF}"
TARBALL="${DIST_DIR}/${IMAGE_NAME}-${IMAGE_TAG}.tar"

step_build() {
  # NOTE: on an Apple-silicon Mac this builds linux/amd64 under QEMU emulation.
  # It works, but pjrt's C++ compile is the slow part and emulation makes it
  # slower still -- budget half an hour or more, and do not be alarmed by it.
  # If that becomes tiresome, the alternatives are (a) push to a registry from
  # a native amd64 runner and pull on the cluster, or (b) build the .sif
  # directly on the cluster with `apptainer build --fakeroot ... docker://...`.
  echo "==> docker buildx build (${DOCKER_PLATFORM})"
  docker buildx build \
    --platform "${DOCKER_PLATFORM}" \
    --build-arg "ANVL_REPO=${ANVL_REPO}" \
    --build-arg "ANVL_REF=${ANVL_REF}" \
    --tag "${IMAGE}" \
    --load \
    .
  echo "==> built ${IMAGE}"
}

step_save() {
  echo "==> docker save -> ${TARBALL}.gz"
  mkdir -p "${DIST_DIR}"
  docker save "${IMAGE}" -o "${TARBALL}"
  gzip -f "${TARBALL}"
  ls -lh "${TARBALL}.gz"
}

# ---- STUB: adjust REMOTE_HOST / REMOTE_DIR in config.sh -------------------
step_ship() {
  echo "==> scp to ${REMOTE_HOST}:${REMOTE_DIR}"
  ssh "${REMOTE_HOST}" "mkdir -p '${REMOTE_DIR}'"
  scp "${TARBALL}.gz" "${REMOTE_HOST}:${REMOTE_DIR}/"
  # Also send the job scripts, so the cluster side is self-contained.
  scp config.sh submit.sh calibrate.sh export.sh slurm-sweep.sbatch slurm-merge.sbatch \
      "${REMOTE_HOST}:${REMOTE_DIR}/"
}

# ---- STUB: runs on the cluster over ssh -----------------------------------
step_sif() {
  echo "==> building ${SIF} on ${REMOTE_HOST}"
  # Singularity needs no root for docker-archive://, so this runs fine on a
  # login node -- but it is disk- and memory-hungry, so point its scratch at
  # somewhere with room. Some sites forbid heavy work on the login node
  # entirely; if yours does, wrap this in a small interactive job instead.
  ssh "${REMOTE_HOST}" bash -s <<REMOTE
set -euo pipefail
cd '${REMOTE_DIR}'
export SINGULARITY_TMPDIR='${REMOTE_DIR}/.singularity-tmp'
export SINGULARITY_CACHEDIR='${REMOTE_DIR}/.singularity-cache'
mkdir -p "\$SINGULARITY_TMPDIR" "\$SINGULARITY_CACHEDIR"
gunzip -kf '${IMAGE_NAME}-${IMAGE_TAG}.tar.gz'
${SINGULARITY} build --force '${SIF}' \
  'docker-archive://${REMOTE_DIR}/${IMAGE_NAME}-${IMAGE_TAG}.tar'
rm -f '${REMOTE_DIR}/${IMAGE_NAME}-${IMAGE_TAG}.tar'
# Not piped into `head`: R dies on SIGPIPE when head closes the pipe early, and
# the resulting "ignoring SIGPIPE signal" error looks like a broken image when
# it is only a closed pipe. Write it out, then read the file.
${SINGULARITY} exec '${SIF}' anvl-sweep list > '${REMOTE_DIR}/.list-check.txt'
head -n 5 '${REMOTE_DIR}/.list-check.txt'
echo '--- plugin, as pinned in the image ---'
${SINGULARITY} exec '${SIF}' sh -c 'ls -l "$PJRT_PLUGIN_PATH_CPU"'
REMOTE
}

case "${1:-all}" in
  build) step_build ;;
  save)  step_save ;;
  ship)  step_ship ;;
  sif)   step_sif ;;
  all)   step_build; step_save; step_ship; step_sif ;;
  *) echo "usage: $0 {build|save|ship|sif|all}" >&2; exit 2 ;;
esac
