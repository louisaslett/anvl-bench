#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Submit the array, then the merge that depends on it.
#
#   ./submit.sh            submit both
#   ./submit.sh --dry-run  print the cells shard 1 would take, and submit nothing
#
# Run this on the cluster, from the directory holding these scripts.
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
CONFIG="$(pwd)/config.sh"
source "${CONFIG}"

require_sif

LOGS="${SWEEP_ROOT}/logs"
mkdir -p "${LOGS}" "${SWEEP_ROOT}/parts" "${SWEEP_ROOT}/store" \
         "${SWEEP_ROOT}/tmp" "${SWEEP_ROOT}/home" "${SWEEP_ROOT}/export"

# Check one shard before committing 40 of them -- --dry-run prints the cells a
# shard would take and runs nothing. HPC.md is emphatic about this and it costs
# ten seconds.
if [[ "${1:-}" == "--dry-run" ]]; then
  "${SINGULARITY}" exec --cleanenv --bind "${SWEEP_ROOT}:/sweeps" \
    --env "NV_SWEEP_STORE=/sweeps/store" --env "HOME=/sweeps/home" \
    "${SIF}" \
    anvl-sweep run --dry-run --depth "${DEPTH}" --backends "${BACKENDS}" \
      ${FILTER:+--filter "${FILTER}"} --shard 1 --shards "${SHARDS}"
  exit 0
fi

COMMON=(--partition="${PARTITION}")
if [[ -n "${ACCOUNT}" ]]; then COMMON+=(--account="${ACCOUNT}"); fi
if [[ -n "${QOS}"     ]]; then COMMON+=(--qos="${QOS}"); fi

ARRAY_ID=$(sbatch --parsable "${COMMON[@]}" \
  --export="ALL,CONFIG=${CONFIG}" \
  --array="1-${SHARDS}" \
  --cpus-per-task="${CPUS_PER_TASK}" \
  --mem="${MEM_PER_TASK}" \
  --time="${WALLTIME}" \
  --output="${LOGS}/sweep-%A_%a.out" \
  --error="${LOGS}/sweep-%A_%a.err" \
  slurm-sweep.sbatch)
echo "sweep array: ${ARRAY_ID}  (${SHARDS} shards, depth=${DEPTH}, backends=${BACKENDS})"

MERGE_ID=$(sbatch --parsable "${COMMON[@]}" \
  --dependency="afterok:${ARRAY_ID}" \
  --time="${MERGE_WALLTIME}" \
  --output="${LOGS}/merge-%j.out" \
  --error="${LOGS}/merge-%j.err" \
  --export="ALL,CONFIG=${CONFIG},ARRAY_JOB_ID=${ARRAY_ID}" \
  slurm-merge.sbatch)
echo "merge job:   ${MERGE_ID}  (afterok:${ARRAY_ID})"
echo
echo "shards land in ${SWEEP_ROOT}/parts/${ARRAY_ID}"
echo "merged store:  ${SWEEP_ROOT}/store"
echo "logs:          ${LOGS}"
echo
echo "when the merge job has finished:  ./export.sh"
