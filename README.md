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

## Comparing with JAX

When an artifact also holds JAX results (the harness's `--backends anvl,jax`),
the site treats **anvl as the subject and JAX as a comparator**: both measured
against the same base R reference, on the same inputs. The overview and every
count stay anvl's alone — a JAX result is never counted as one of anvl's. JAX
appears beside anvl on each function's page, and on each result page as a
second column of figures, an ink line over the binade chart and the histogram,
and a tab on the worst inputs. Variants JAX does not offer (for example
`log_p = TRUE` quantiles) say so rather than showing blanks.

JAX is always drawn as a line over anvl's filled marks, so the two are told apart
by the kind of mark and a direct label, not by one more colour. The binade
behaviour colours were chosen with a colour-vision validator and pass in both
light and dark mode.

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

Which Release is deployed is recorded in the **`DEPLOY_RELEASE`** file at the
root of this repository — one line holding a release tag. Deploying is therefore
an ordinary commit:

```bash
# edit the tag on the last line of DEPLOY_RELEASE, then:
git commit -am "Deploy v0.4.0" && git push
```

The push triggers the workflow, and the diff is the record of which results went
live and when. Naming a tag here is not the same as moving one: a Release is
bound one-to-one to its tag, and this file just points at one.

An empty file deploys the site with no data, which is a perfectly good state —
the file picker still works.

To look at a different Release **without** changing what is deployed, run the
workflow by hand with its `release` input (*Actions → Deploy site → Run
workflow*, or `gh workflow run "Deploy site" -f release=<tag>`). That overrides
the file for that run only and does not persist. A repository variable named
`DEPLOY_RELEASE` is also honoured, but only when the file is absent.

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

Note the files sit at the zip's **root**, not inside a folder. To pack an export
sitting in `data/`:

```bash
mkdir -p dist && (cd data && zip -q -r ../dist/<id>.zip . -x '.*')
```

Pick an `<id>` that is unique within the Release: the platform key alone is
enough when a Release carries one anvl version, which is the usual case. The
dropdown's label comes from the manifest, not from this name.

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

One hosting detail the reader has to know about: **GitHub Pages gzips these
responses**, including `application/octet-stream`, so a `HEAD` reports the
*compressed* length — 12,625 where the file is 18,946. Taken as the file size
that puts the Parquet footer read in the middle of the file
(`footer != PAR1`). A ranged request, however, is answered from the
uncompressed bytes and gives the true total in `content-range`, so that is
where `js/source.js` gets the length from. `tools/serve.mjs` reproduces both
behaviours, because a dev server that simply serves uncompressed hides this
entirely and the site fails only once deployed.

`manifest.json` is the only JSON in an artifact. Everything measured is
Parquet, because JSON cannot represent `NaN`, `±Inf` or `-0`, all of which occur
in these results and all of which mean something specific.

### Caching

Pages serves everything with `cache-control: max-age=600`, and that is not
configurable. Left alone, a returning visitor within ten minutes of a deploy can
end up running **some** old modules and some new ones — which is exactly how a
site that had already been fixed kept showing the old error.

So the deploy step stamps every internal reference (`index.html` → `js/app.js`
and `css/app.css`, and each module's relative imports) with the commit SHA.
Each deploy is therefore a distinct set of URLs and a page is always served
whole: all old, or all new. `index.html` itself is still cached for up to ten
minutes, so a returning visitor may see the previous version for that long —
but a self-consistent one, and a hard reload always gets the newest.

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
DEPLOY_RELEASE          the release this site is deployed from
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
#/cell/<cell_id>/<output>?z=<from>-<to>             one result, zoomed to a range
```

All paths in the site are relative, so it works as a project page today and
would work unchanged under an organisation.
