# `hpc/` — running the full sweep on a cluster under Singularity

The sweep harness lives in the **anvl** repository
(`benchmarks/api-distributions`, on `louisaslett/anvl` branch
`sweep-benchmarks`); this directory is only the machinery for running it
somewhere with 40 nodes instead of one laptop, and getting a release asset back.

At `full` depth the grid is ~5 days serial on an M1. That is the reason for the
array job. The bigger reason to go at all is the **`linux-x86_64-cpu` column
itself** — the subnormal flush-to-zero this project documented is, so far, a
single-platform observation.

```
config.sh            the only file you must edit
Dockerfile           the whole r-xla stack + the harness + JAX, from GitHub
build.sh             build (amd64) -> save -> scp -> .sif
submit.sh            submit the array, then the merge that depends on it
calibrate.sh         one shard at quick depth, then its CPU efficiency
slurm-sweep.sbatch   one array task per shard
slurm-merge.sbatch   fold the shards into the analysis store
export.sh            head node, no Slurm: store -> anvl-bench release zip
```

## The workflow

```bash
# 1. on the Mac — edit config.sh first
./build.sh all            # or: build / save / ship / sif, one at a time

# 2. on the cluster, in REMOTE_DIR
./calibrate.sh submit     # one shard at quick depth, to size CPUS_PER_TASK
./calibrate.sh report <jobid>
./submit.sh --dry-run     # what shard 1 would take; runs nothing
./submit.sh               # array + dependent merge

# 3. when the merge job has finished
./export.sh               # -> $SWEEP_ROOT/dist/linux-x86_64-cpu.zip
```

Then attach that zip to a Release in this repository and point `DEPLOY_RELEASE`
at the tag — the ordinary anvl-bench deploy, unchanged.

```bash
# Upload ...
gh release upload <tag> linux-x86_64-cpu.zip --repo louisaslett/anvl-bench

# ... or if for some reason a release needs to be overwritten:
gh release upload <tag> linux-x86_64-cpu.zip --clobber --repo louisaslett/anvl-bench

# Run Github Action to deploy site copying in the uploaded zip (only run after
# updating DEPLOY_RELEASE)
gh workflow run "Deploy site"
```

## Where things are written

**Nothing is written inside the container.** `SWEEP_ROOT` in `config.sh` is a
path on the cluster filesystem, bind-mounted at `/sweeps`, and it is the one
path you must get right:

```
$SWEEP_ROOT/
  parts/<array job id>/   each array task's own store — write-once, one Parquet
                          file per (run, cell), so no locking and no contention
  store/                  the analysis store, merged into after the array
  export/                 the six Parquet files + manifest.json
  dist/<id>.zip           the release asset
  logs/                   Slurm stdout/stderr
  home/  tmp/             HOME and TMPDIR for the container
```

Put it on scratch or project space. `HOME` and `TMPDIR` are redirected there on
purpose: R, reticulate and XLA all write caches under `HOME`, and a quota'd home
directory is the classic way for task 37 of 40 to die at hour six.

The store is keyed by array job id, so two submissions can never mix, and the
merge runs `afterok` so a partial array is never folded in — `status` counts
cells against the declared grid, and a half-merged run reads as "never run" for
everything still missing.

## Choices the image makes, and why

- **The clones are siblings under `/opt/r-xla`.** The harness records each
  ecosystem package's git SHA per run by looking at `<anvl>/../<pkg>`. A
  flatter layout builds fine and silently produces NA provenance.
- **`R CMD INSTALL` per package, never `pak`/`devtools`.** Those follow anvl's
  `Remotes:` and pull the siblings from GitHub main over the pinned clones,
  which breaks anvl whenever the ecosystem is mid-migration. CRAN dependencies
  are read out of the five `DESCRIPTION`s at build time rather than listed in
  the Dockerfile, so a new `Imports:` upstream needs no edit here.
- **`git config --system --add safe.directory '*'`.** Under Singularity the
  container runs as your uid while `/opt/r-xla` is owned by root, and git then
  refuses to report HEAD — emptying exactly the provenance columns above.
- **The PJRT CPU plugin is downloaded at build time** and pinned with
  `PJRT_PLUGIN_PATH_CPU`, not left to first use: a compute node may have no
  outbound network, the default cache path is derived from `HOME` (which is
  yours, not the build's), and 40 tasks racing to populate one cache directory
  is a corruption waiting to happen.
- **System libraries come from `pak::pkg_sysreqs()`, and are checked.** P3M's
  Linux binaries link libraries the base image lacks (`fs` needs libuv), and
  `R CMD INSTALL` does not notice — the first symptom is a `dyn.load()` failure
  at first use, layers later. The build scans every installed `.so` with `ldd`
  and fails on any unresolved soname, with `LD_LIBRARY_PATH` set to R's own lib
  so that `libR.so` does not report as missing for every package.
- **JAX is a venv at `/opt/py`, pinned with `RETICULATE_PYTHON`.** Without the
  pin the harness looks for `../../../py-benchmarks/.venv`, which is not in the
  image. `jax_enable_x64` is set by the harness itself, not here.
- **`--cleanenv` on every `singularity exec`.** It strips the *host's*
  environment, not the image's, so the pins above survive and a stray
  `R_LIBS_USER` or `PJRT_*` on the login node cannot leak into a run.
- **The build runs `anvl-sweep selftest`.** A sweep that silently sweeps
  nothing looks exactly like a sweep that found nothing, and at full depth that
  is an expensive way to find out.

## Cores per task

`OMP_NUM_THREADS` and friends do **not** govern this workload. XLA parallelises
each kernel over an intra-op thread pool it sizes from the schedulable-CPU
count, and neither pjrt nor anvl exposes a knob for it — measured on an
unbound machine, one anvl process on one jitted `nv_qnorm` spread over ~3.5
cores and 29 threads. (`--xla_cpu_multi_thread_eigen=false` only trims it to
~2.3; the thunk runtime parallelises independently of that legacy flag.)

What holds a task to its allocation is therefore **CPU affinity**, which is
Slurm's job, not this script's. `slurm-sweep.sbatch` runs the container under
`srun --cpu-bind=cores` so the binding is requested explicitly rather than
inherited from whatever the batch step got, and logs the container's own
`Cpus_allowed_list` per shard — which is the only way to confirm it actually
happened at your site. Even if the pool were sized wrongly, a cpuset-bound
task oversubscribes *within* its own CPUs and cannot take cores from a
neighbouring job.

The thread-count variables are pinned to 1 rather than to `CPUS_PER_TASK`: they
reach R's BLAS, which this workload barely touches, and a BLAS pool sized to
the whole allocation would only contend with XLA's for the same cores.

## Sizing the array

`SHARDS=40` is a starting point, not a recommendation. Cells are independent
and the split is `cell_id %% shards`, so any number works — but **every shard
pays R startup, package load and an XLA compile per distinct cell shape**, so
40 short shards pay that 40 times. Prefer fewer, longer shards, and size
`WALLTIME` from one `full` cell timed locally rather than from the table in the
harness README (which is M1 numbers).

With `BACKENDS="anvl,jax"` the grid is 320 cells rather than 160: the JAX twin
of every cell runs in the same task, which is what makes the comparison
same-machine, same-inputs. Set `BACKENDS="anvl"` to halve it.

Memory is flat in the sample count — the reducers are streaming — so a cell
cannot grow out of `MEM_PER_TASK`. Walltime is the binding constraint.

One thing to check on a smoke shard before committing to 40 x 4: **XLA
compilation is largely single-threaded**, so a shard's compile phase leaves all
but one of its cores idle, and the grid pays one compile per distinct cell
shape *per shard*. If average utilisation comes out low, the better trade is
fewer cores per task and more shards, not more cores.

## Monitoring the job

```
squeue --me
sacct -j <jobid> -X --format=JobID,JobName,State,Elapsed,TotalCPU
```

## If you later want the CUDA column

This image is CPU-only by choice. A GPU variant needs `install_pjrt(cuda =
TRUE)` plus the `pjrt.cuda` R package, a plugin built against a CUDA the
cluster's *driver* accepts (check `nvidia-smi` on a compute node, not the login
node), `--nv` on every `singularity exec`, and `NV_SWEEP_DEVICE=cuda`. That
last one matters more than it looks: it feeds `platform_key`, and a CUDA run
mislabelled `cpu` merges into the CPU column and corrupts the one comparison
the trip was for.
