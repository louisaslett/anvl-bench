# anvl-bench

A static site presenting bit-pattern accuracy sweeps of
[anvl](https://github.com/r-xla/anvl)'s distribution functions against base R.

Each function is swept over the float bit patterns themselves — exhaustively in
f32 (all 2<sup>32</sup>), and one sample per 2<sup>32</sup>-block in f64 — for
values and for every derivative. The sweeps are produced by
`benchmarks/api-distributions` in the anvl repository; this repository only
presents their results.

> A disagreement with base R is not by itself a defect in anvl. Base R is the
> reference these sweeps compare against, not an oracle, and in places it is the
> weaker implementation. The site is worded accordingly.

## How the results get here

Results are **never committed to this repository**. They are published as assets
on a GitHub Release, and a workflow copies the chosen Release's assets into the
Pages artifact at deploy time.

That indirection is necessary, not stylistic. **A browser cannot read GitHub
Release asset bytes.** The REST asset endpoint sets CORS headers on its `302`,
but the signed `release-assets.githubusercontent.com` target it redirects to
does not, and a preflight there answers `405`. (Release *discovery* through the
JSON API works fine; only the bytes are unreachable.) GHCR was ruled out for the
same reason — `ghcr.io/token` fails CORS before the manifest is reached.
Copying the assets into the Pages artifact makes them same-origin, and they
still never enter git history.

```
Release asset (canonical)  ->  Actions downloads it  ->  Pages artifact  ->  browser
```

Which Release is deployed is set by the repository variable `DEPLOY_RELEASE`
(*Settings → Secrets and variables → Actions → Variables*), and can be
overridden for a single run from the Actions tab. It is a variable rather than a
moving tag because a Release is bound one-to-one to its tag.

Anyone can also look at a Release that is **not** deployed: download its assets
and open them with the file picker in the page header. `fetch` is blocked on
`file://`, but file inputs are not, so this works even from a local copy.

### Release asset layout

One `.zip` per (anvl version, platform, backend), holding a whole export at its
root. The asset's basename becomes the artifact id and the directory it is
unpacked into:

```
darwin-arm64-cpu.zip
  manifest.json
  runs.parquet  summary.parquet  detail.parquet
  bands.parquet  hist.parquet  ranges.parquet
```

## Reading strategy

`detail.parquet` is ~46 MB and the site never downloads it. Both large tables
are sorted by cell with a row group boundary at every cell, and the Parquet
footer carries exact `min`/`max` statistics on `cell_id`, so the row group
holding one cell is located from the footer alone and read on its own over HTTP
range requests. Measured against a real deployment-shaped artifact:

| operation | fetched | time |
| --- | --- | --- |
| `manifest.json` + `summary.parquet` (the whole index and overview) | 31.9 kB | 16 ms |
| drill into one cell of a 46 MB `detail.parquet` | 0.56 MB — 1.2% | 111 ms |

The reader is [hyparquet](https://github.com/hyparam/hyparquet) (~10 kB, pure
JS, no WASM), the only third-party dependency, pinned in `js/hyparquet.js`.
DuckDB-WASM was rejected at ~30 MB — larger than the data it would read.

`manifest.json` is the only JSON in an artifact. Everything measured is
Parquet, because JSON cannot represent `NaN`, `±Inf` or `-0`, all of which occur
in these results and all of which mean something specific.

## Local development

Generate an artifact from the sweep harness:

```bash
# from the anvl checkout carrying the sweep harness
cd <anvl>/benchmarks/api-distributions
Rscript run.R run --depth smoke --jobs 8
Rscript run.R export --out <anvl-bench>/data
```

Then serve the repository root:

```bash
node tools/serve.mjs 8099
```

`tools/serve.mjs` exists because Python's `http.server` does not implement Range
requests, which this site depends on entirely. It mirrors what Pages does,
including `accept-ranges: bytes`.

A single artifact can sit directly in `data/`. For several, put each in
`data/<id>/` and build the dropdown's index:

```bash
node tools/build-data-index.mjs data
```

`data/` is git-ignored in its entirety.

## Layout

```
index.html              the only page; everything else is routed in the hash
css/app.css
js/hyparquet.js         the pinned dependency, imported in one place
js/fmt.js               formatting, including the values JSON cannot carry
js/source.js            where bytes come from: deployed URL, or local files
js/store.js             what to read and how little of it
js/chart.js             hand-written SVG; no charting library
js/app.js               router and views
tools/serve.mjs         range-capable dev server
tools/build-data-index.mjs
.github/workflows/deploy.yml
```

URLs carry the whole navigable state, so a finding can be linked from an issue:

```
#/                                                  overview
#/spec/nv_qnorm                                     one function
#/cell/<cell_id>/<output>?b=<binade>                one result, one binade
```

All paths in the site are relative, so it works as a project page today and
would work unchanged under an organisation.
