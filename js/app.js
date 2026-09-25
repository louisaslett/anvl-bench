// Router and views.
//
// The URL is the whole of the navigable state, so any finding on this site can
// be linked from an issue:
//
//   #/                                             overview
//   #/spec/nv_qnorm                                one function
//   #/cell/<cell_id>/<output>[?z=<from>-<to>]      one result, zoomed to a range
//
// Only the leaf route fetches anything beyond the index.

import { listDeployed, urlSource, fileSource } from "./source.js";
import { openStore, isUnexplained } from "./store.js";
import { binadeChart, histChart, BEHAVIOUR } from "./chart.js";
import { num, int, pct, cellParts, flagList } from "./fmt.js";

// --- tiny DOM helper ---------------------------------------------------

function h(tag, attrs = {}, ...kids) {
  const [name, ...cls] = tag.split(".");
  const n = document.createElement(name || "div");
  if (cls.length) n.className = cls.join(" ");
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") n.className = `${n.className} ${v}`.trim();
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const k of kids.flat(9)) {
    if (k === null || k === undefined || k === false) continue;
    n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return n;
}

// Wrapped, so a wide table scrolls within itself rather than dragging the
// whole page sideways on a narrow screen.
/**
 * Replace a node's children, skipping empty entries. The DOM's own
 * replaceChildren() stringifies null, which once printed a literal "null" on
 * every page where an optional panel part (the JAX key, the zoom note) was
 * absent.
 */
const put = (node, ...kids) =>
  node.replaceChildren(...kids.flat(9).filter((k) => k !== null && k !== undefined && k !== false));

const table = (headers, rows) =>
  h("div.table-wrap", { tabindex: "0", role: "region", "aria-label": "results" },
    h("table.grid", {},
      h("thead", {}, h("tr", {}, headers.map((c) =>
        h("th", { class: [c.align === "r" ? "r" : null, c.cls].filter(Boolean).join(" ") || null,
        title: c.hint ?? null }, c.label ?? c)))),
      h("tbody", {}, rows)));

/** How a backend is named on screen. */
const backendLabel = (b) => ({ anvl: "anvl", jax: "JAX" })[b] ?? b;

// --- routes ------------------------------------------------------------

const cellHref = (cellId, output, extra = "") =>
  `#/cell/${encodeURIComponent(cellId)}/${encodeURIComponent(output)}${extra}`;
const specHref = (spec) => `#/spec/${encodeURIComponent(spec)}`;

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, qs] = raw.split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const q = new URLSearchParams(qs ?? "");
  if (parts[0] === "spec" && parts[1]) return { view: "spec", spec: parts[1] };
  if (parts[0] === "cell" && parts[1] && parts[2]) {
    // The zoom is a half-open range of binade columns along the chart's axis.
    // `b=<n>` is the single-binade link of an earlier version; it still opens.
    let zoom = null;
    const z = /^(\d+)-(\d+)$/.exec(q.get("z") ?? "");
    if (z && Number(z[2]) > Number(z[1])) zoom = [Number(z[1]), Number(z[2])];
    else if (/^\d+$/.test(q.get("b") ?? "")) zoom = [Number(q.get("b")), Number(q.get("b")) + 1];
    return { view: "cell", cellId: parts[1], output: parts[2], zoom };
  }
  return { view: "overview" };
}

// --- state -------------------------------------------------------------

const app = {
  store: null,
  deployed: [],
  chartCell: null,
  detailBackend: null, // whose worst inputs are listed; reset with the result
  redrawCell: null, // redraws the open result page for a new zoom, in place
  gen: 0, // bumped per result render, so a slow one cannot claim the page
};

const main = () => document.getElementById("main");
const setStatus = (msg, cls = "") => {
  put(main(), h(`p.status.${cls}`.replace(/\.$/, ""), {}, msg));
};

// --- header ------------------------------------------------------------

function renderHeader() {
  const bar = document.getElementById("source-bar");
  const m = app.store?.manifest;
  const kids = [];

  if (app.deployed.length > 1) {
    const sel = h("select", {
      "aria-label": "deployed artifact",
      onchange: async (e) => { await load(urlSource(e.target.value)); route(); },
    }, app.deployed.map((a) =>
      h("option", { value: a.dir, selected: app.store?.source?.origin === `${a.dir}/` },
        a.label ?? a.id)));
    kids.push(h("label.field", {}, "Artifact ", sel));
  }

  const picker = h("input", {
    type: "file",
    multiple: true,
    id: "file-picker",
    onchange: async (e) => {
      if (!e.target.files.length) return;
      try {
        await load(fileSource(e.target.files));
        location.hash = "#/";
        route();
      } catch (err) {
        setStatus(String(err.message ?? err), "error");
      }
    },
  });
  kids.push(h("label.field", {},
    "Open a local artifact ", picker,
    h("span.hint", { title: "Release asset bytes cannot be fetched by a browser, so a version that is not deployed has to be downloaded first and opened from disk." }, "?")));

  if (m) {
    kids.push(h("div.source-meta", {},
      h("span.tag", {}, m.platforms?.join(", ") ?? "?"),
      h("span.tag", {}, `anvl ${m.anvl_version?.join(", ") ?? "?"}`),
      h("span.tag", {}, `${m.depths?.join(", ") ?? "?"} depth`),
      h("span.muted", {}, `· ${app.store.source.origin}`)));
  }
  put(bar, ...kids);
}

// --- overview ----------------------------------------------------------

function aggregate(rows) {
  const samples = rows.reduce((a, r) => a + (r.n_samples ?? 0), 0);
  const exact = rows.reduce((a, r) => a + (r.n_exact ?? 0), 0);
  const finite = rows.map((r) => r.worst_rel_err).filter((v) => typeof v === "number" && !Number.isNaN(v));
  return {
    n: rows.length,
    samples,
    exactFrac: samples ? exact / samples : null,
    worst: finite.length ? Math.max(...finite) : null,
    unexplained: rows.filter(isUnexplained).length,
    failed: rows.filter((r) => r.error !== null && r.error !== undefined).length,
  };
}

function renderOverview() {
  const s = app.store;
  const dtypes = [...new Set(s.summary.map((r) => r.dtype))].sort();
  const all = aggregate(s.summary);

  const out = [h("h1", {}, "Accuracy of anvl's distribution functions")];

  out.push(h("p.lede", {},
    `Every function is swept against base R over float bit patterns: exhaustively in f32, ` +
    `and one sample per 2`, h("sup", {}, "32"), `-block in f64. `,
    int(all.samples), ` samples across `, int(all.n), ` results.`));
  if (s.comparators.length) {
    const cmp = backendLabel(s.comparators[0]);
    const nTwin = s.summary.filter((r) => s.twin(r)).length;
    out.push(h("p.lede", {},
      `${cmp} is swept alongside as a comparator, against the same base R reference and on the same inputs. `,
      `${nTwin} of ${all.n} anvl results have a ${cmp} equivalent; the rest are variants ${cmp} does not offer. `,
      `Every figure on this page is anvl's own \u2014 the comparison is on each function's page and each result's page.`));
  }

  // The headline: where disagreement is left unexplained by NaN, subnormals or
  // the edges of the support.
  const bySpec = s.specs
    .map((spec) => ({ spec, n: s.bySpec(spec).filter(isUnexplained).length }))
    .filter((d) => d.n > 0)
    .sort((a, b) => b.n - a.n);
  out.push(h(`div.callout.${all.unexplained ? "warn" : "ok"}`, {},
    h("strong", {}, all.unexplained
      ? `${all.unexplained} of ${all.n} results disagree with base R somewhere nothing explains`
      : "Every disagreement with base R is accounted for"),
    all.unexplained
      ? h("p", {}, "Concentrated in ", bySpec.map((d, i) =>
          [i ? ", " : "", h("a", { href: specHref(d.spec) }, `${d.spec} (${d.n})`)]), ". ",
          h("span.muted", {}, "A disagreement is not by itself a defect in anvl — base R is the reference here, not the truth, and is sometimes the weaker implementation."))
      : null));

  // One tile per function, split by precision.
  const grid = h("div.tiles");
  for (const spec of s.specs) {
    const rows = s.bySpec(spec);
    const tile = h("a.tile", { href: specHref(spec) }, h("h2", {}, spec));
    const body = h("div.tile-body");
    for (const dt of dtypes) {
      const a = aggregate(rows.filter((r) => r.dtype === dt));
      if (!a.n) continue;
      body.append(h("div.tile-row", {},
        h("span.dt", {}, dt),
        h("span.metric", { title: "largest relative error against base R" },
          num(a.worst, 3)),
        h("span.metric.muted", { title: "samples bit-identical to base R" }, pct(a.exactFrac)),
        a.unexplained
          ? h("span.pill.warn", { title: "results with unexplained disagreement" }, `${a.unexplained}`)
          : h("span.pill.ok", { title: "all disagreement explained" }, "✓")));
    }
    tile.append(body);
    grid.append(tile);
  }
  out.push(grid);
  out.push(h("p.legend", {},
    "Each row of a tile: precision, worst relative error against base R, ",
    "share of samples bit-identical to base R, and the number of results with ",
    "disagreement that nothing explains."));

  out.push(renderRuns());
  put(main(), ...out);
}

function renderRuns() {
  const s = app.store;
  const fields = [
    ["host", "host"], ["os", "os"], ["os_version", "os version"], ["arch", "arch"],
    ["cpu", "cpu"], ["n_cores", "cores"], ["device", "device"], ["r_version", "R"],
    ["depth", "depth"], ["branch", "branch"], ["sweep_seed", "seed"],
    ["default_float", "default float"], ["default_int", "default int"],
    ["anvl_version", "anvl"], ["anvl_sha", "anvl sha"],
    ["stablehlo_version", "stablehlo"], ["stablehlo_sha", "stablehlo sha"],
    ["pjrt_version", "pjrt"], ["pjrt_sha", "pjrt sha"],
    ["tengen_version", "tengen"], ["tengen_sha", "tengen sha"],
    ["xlamisc_version", "xlamisc"], ["xlamisc_sha", "xlamisc sha"],
  ];
  const body = h("div.runs");
  for (const run of s.runs) {
    const dl = h("dl.fingerprint");
    for (const [k, label] of fields) {
      if (!(k in run) || run[k] === null || run[k] === undefined) continue;
      const v = String(run[k]);
      dl.append(h("div.stat", {}, h("dt", {}, label),
        h("dd", { class: /_sha$/.test(k) ? "mono" : null, title: v },
          /_sha$/.test(k) ? v.slice(0, 12) : v)));
    }
    body.append(h("div.run", {},
      h("h3", {}, run.started_at ?? run.run_id), dl));
  }
  return h("details.fold", {}, h("summary", {}, `Environment (${s.runs.length} run${s.runs.length === 1 ? "" : "s"})`), body);
}

// --- one function ------------------------------------------------------

const SORTS = {
  worst: (a, b) => (b.worst_rel_err ?? -1) - (a.worst_rel_err ?? -1),
  ulp: (a, b) => (b.worst_ulp_err ?? -1) - (a.worst_ulp_err ?? -1),
  exact: (a, b) => (a.n_exact / a.n_samples) - (b.n_exact / b.n_samples),
  name: (a, b) => a.cell_id.localeCompare(b.cell_id) || a.output.localeCompare(b.output),
};
let specSort = "worst";

function renderSpec(spec) {
  const s = app.store;
  const rows = s.bySpec(spec);
  const cmp = s.comparators[0];
  // The comparator's figures for the same cell, beside anvl's. No verdict
  // column: the two numbers are shown and the reader compares them.
  const cmpCells = (r) => {
    if (!cmp) return null;
    const t = s.twin(r, cmp);
    if (!t) {
      return h("td.muted.cmp.none", { colspan: 2, title: `${backendLabel(cmp)} has no equivalent of this variant` },
        `no ${backendLabel(cmp)} equivalent`);
    }
    return [
      h("td.r.cmp", {}, num(t.worst_rel_err, 3)),
      h("td.r.cmp", {}, pct(t.n_exact / t.n_samples)),
    ];
  };
  if (!rows.length) return setStatus(`No results for ${spec} in this artifact.`, "error");
  const a = aggregate(rows);

  const sorted = [...rows].sort(SORTS[specSort] ?? SORTS.worst);
  const body = sorted.map((r) => h("tr", { class: isUnexplained(r) ? "row-warn" : null },
    h("td", {}, h("a", { href: cellHref(r.cell_id, r.output) },
      h("span.dt", {}, r.dtype), " ", r.kind, " ", h("span.muted", {}, r.param_set))),
    h("td.flags", {}, flagList(r.flags).map((f) => h("span.chip.flag", {}, f))),
    h("td", {}, h("code", {}, r.output)),
    h("td.r", {}, num(r.worst_rel_err, 3)),
    h("td.r", {}, num(r.worst_ulp_err, 3)),
    h("td.r", {}, pct(r.n_exact / r.n_samples)),
    h("td", {}, isUnexplained(r)
      ? h("a.pill.warn", { href: cellHref(r.cell_id, r.output) },
        `${num(Math.abs(r.unexplained_from), 2)} … ${num(Math.abs(r.unexplained_to), 2)}`)
      : h("span.pill.ok", {}, "✓")),
    cmpCells(r)));

  const sortSel = h("select", { onchange: (e) => { specSort = e.target.value; renderSpec(spec); } },
    [["worst", "worst relative error"], ["ulp", "worst ulp error"],
     ["exact", "least bit-identical"], ["name", "name"]].map(([v, l]) =>
      h("option", { value: v, selected: v === specSort }, l)));

  put(main(),
    h("nav.crumbs", {}, h("a", { href: "#/" }, "overview"), " / ", h("span", {}, spec)),
    h("h1", {}, spec),
    h("p.lede", {}, `${a.n} results, ${int(a.samples)} samples in all. `,
      a.unexplained
        ? h("strong", {}, `${a.unexplained} with unexplained disagreement.`)
        : "All disagreement with base R is explained."),
    h("label.field", {}, "Sort by ", sortSel),
    table([
      { label: "cell", hint: "precision, value or gradient, parameter set" },
      "flags",
      { label: "output", hint: "value, or the argument differentiated" },
      { label: "worst rel err", align: "r" }, { label: "worst ulp", align: "r" },
      { label: "bit-identical", align: "r" },
      { label: "unexplained", hint: "range of x where disagreement is not explained by NaN, subnormals or the edge of the support" },
      // anvl's own columns first; the comparator's follow as an appendix.
      ...(cmp ? [
        { label: `${backendLabel(cmp)} worst rel err`, align: "r", cls: "cmp", hint: `${backendLabel(cmp)}, on the same inputs, against the same base R reference` },
        { label: `${backendLabel(cmp)} bit-identical`, align: "r" },
      ] : []),
    ], body));
}

// --- one result --------------------------------------------------------

async function renderCell(cellId, output, zoom) {
  app.redrawCell = null;
  const gen = ++app.gen;
  const s = app.store;
  const r = s.result(cellId, output);
  if (!r) return setStatus(`No result for ${cellId} / ${output} in this artifact.`, "error");
  const parts = cellParts(cellId);

  // The comparator's twin: the same cell and output, from another backend. Only
  // anvl's results are compared; a comparator is never a page's subject.
  const cmp = r.backend === s.primary ? s.comparators[0] : undefined;
  const t = cmp ? s.twin(r, cmp) : undefined;
  const cmpLabel = cmp ? backendLabel(cmp) : null;
  const me = backendLabel(r.backend);

  // The worst-inputs tab is per result; a new one starts on anvl.
  const key = `${cellId}/${output}`;
  if (app.chartCell !== key) {
    app.chartCell = key;
    app.detailBackend = null;
  }

  const STATS = [
    ["worst relative error", (x) => num(x.worst_rel_err)],
    ["worst ulp error", (x) => num(x.worst_ulp_err)],
    ["bit-identical to base R", (x) => pct(x.n_exact / x.n_samples)],
    ["worst at x", (x) => [num(x.worst_x), " ", h("code.bits", {}, x.worst_bits ?? "")]],
    ["its value there", (x) => num(x.worst_value)],
    ["base R there", (x) => num(x.worst_reference)],
    ["samples", (x) => int(x.n_samples)],
  ];
  const stats = t
    ? h("div.compare", {}, table(
      [{ label: "" }, { label: me, align: "r" }, { label: cmpLabel, align: "r" }],
      STATS.map(([k, f]) => h("tr", {},
        h("th", { scope: "row" }, k), h("td.r", {}, f(r)), h("td.r.cmp", {}, f(t))))))
    : h("dl.stats", {}, STATS.map(([k, f]) => h("div.stat", {}, h("dt", {}, k), h("dd", {}, f(r)))));

  const between = (x) => [h("code", {}, num(x.unexplained_from)), " and ", h("code", {}, num(x.unexplained_to))];
  const twinSays = t
    ? (isUnexplained(t)
      ? h("p", {}, `${cmpLabel} also disagrees with base R somewhere nothing explains, between `, between(t),
        ". Where both implementations part company with base R in the same place, the reference itself is worth a look.")
      : h("p", {}, `${cmpLabel}'s disagreements with base R on this cell are all explained.`))
    : null;
  const callout = isUnexplained(r)
    ? h("div.callout.warn", {},
      h("strong", {}, "Unexplained disagreement"),
      h("p", {}, "Between ", between(r),
        ` ${me} and base R differ for reasons not accounted for by NaN, subnormal flush-to-zero, or the edges of the support. `,
        h("span.muted", {}, "Which of the two is closer to the true value is a separate question; base R is the reference, not an oracle.")),
      twinSays)
    : (t && isUnexplained(t)
      ? h("div.callout", {},
        h("strong", {}, `${cmpLabel} disagrees here; ${me} does not`),
        h("p", {}, `Between `, between(t), ` ${cmpLabel} differs from base R for reasons nothing explains. Every disagreement ${me} has on this cell is explained.`))
      : null);

  const noTwin = !t && s.comparators.length && r.backend === s.primary
    ? h("p.note", {}, `${backendLabel(s.comparators[0])} has no equivalent of this variant, so there is nothing to compare it with here.`)
    : null;

  const head = [
    h("nav.crumbs", {},
      h("a", { href: "#/" }, "overview"), " / ",
      h("a", { href: specHref(r.spec) }, r.spec), " / ",
      h("span", {}, `${parts.dtype} ${parts.kind} ${parts.param_set}`), " / ",
      h("code", {}, output)),
    h("h1", {}, r.spec, " ", h("span.dt", {}, parts.dtype), " ",
      h("span.muted", {}, parts.kind === "grad" ? `d/d${output}` : "value")),
    h("div.chips", {}, h("span.chip", {}, parts.param_set),
      flagList(parts.flags).map((f) => h("span.chip.flag", {}, f)),
      h("span.chip", {}, me), t ? h("span.chip", {}, `compared with ${cmpLabel}`) : null),
    stats,
    noTwin,
    callout,
  ];

  const slots = {
    bands: h("section.panel", {}, h("h2", {}, "Worst relative error by binade"), h("p.status", {}, "reading…")),
    hist: h("section.panel", {}, h("h2", {}, "Distribution of relative error"), h("p.status", {}, "reading…")),
    detail: h("section.panel", {}, h("h2", {}, "Worst inputs"), h("p.status", {}, "reading…")),
    ranges: h("section.panel", {}, h("h2", {}, "Regions with no finite error"), h("p.status", {}, "reading…")),
  };
  put(main(),
    ...head.filter(Boolean), slots.bands, slots.hist, slots.detail, slots.ranges);

  const forOutput = (rows) => rows.filter((x) => x.output === output);
  const rowsOf = (tbl, id) => (id ? s.cellRows(tbl, id).then(forOutput) : Promise.resolve([]));
  const tId = t?.cell_id ?? null;
  const [bands, hist, detail, ranges, tBands, tHist, tDetail, tRanges] = await Promise.all([
    rowsOf("bands", cellId), rowsOf("hist", cellId), rowsOf("detail", cellId), rowsOf("ranges", cellId),
    rowsOf("bands", tId), rowsOf("hist", tId), rowsOf("detail", tId), rowsOf("ranges", tId),
  ]);
  // The reader may have moved on while this was loading.
  if (gen !== app.gen) return;

  const cmpKey = t ? h("span.key-item", {}, h("i.k-cmp"), `${cmpLabel} (line)`) : null;

  // Columns in the chart's order: along the real line, most negative first.
  // A zoom is a range of these, and everything below follows it by matching
  // (sign, binade) -- the same interval for any backend at one precision.
  const columns = bands.filter((b) => !b.special)
    .sort((a, b) => (a.sign < 0 ? -1 : 1) - (b.sign < 0 ? -1 : 1) ||
      (a.sign < 0 ? b.binade - a.binade : a.binade - b.binade));
  const bkey = (x) => `${x.sign}:${x.binade}`;
  const zoomHref = (v) => cellHref(cellId, output, v ? `?z=${v[0]}-${v[1]}` : "");

  // A no-finite-error region is stored as a run of bit patterns. Its binades,
  // read straight off the exponent field, say exactly which columns it covers.
  const layout = parts.dtype === "f64" ? { sign: 63n, exp: 52n, mask: 0x7ffn } : { sign: 31n, exp: 23n, mask: 0xffn };
  const fieldsOf = (hex) => {
    const v = BigInt(hex);
    return { sign: (v >> layout.sign) & 1n ? -1 : 1, binade: Number((v >> layout.exp) & layout.mask) };
  };
  const rangeKeys = (x) => {
    const a = fieldsOf(x.bits_from);
    const b = fieldsOf(x.bits_to);
    const keys = [];
    const top = Number(layout.mask);
    // Bit order runs +0 .. +NaN, then -0 .. -NaN, so a run can cross the sign.
    const run = (sign, lo, hi) => { for (let i = lo; i <= hi; i++) keys.push(`${sign}:${i}`); };
    if (a.sign === b.sign) run(a.sign, Math.min(a.binade, b.binade), Math.max(a.binade, b.binade));
    else { run(a.sign, a.binade, top); run(b.sign, 0, b.binade); }
    return keys;
  };

  const draw = (view) => {
    const v = view && view[0] < columns.length ? [view[0], Math.min(view[1], columns.length)] : null;
    const inView = v ? new Set(columns.slice(v[0], v[1]).map(bkey)) : null;
    const within = (x) => !inView || inView.has(bkey(x));
    const lo = v ? columns[v[0]] : null;
    const hi = v ? columns[v[1] - 1] : null;
    // A function, not a value: a DOM node lives in one place, so each use of the
    // range's bounds needs its own copy or the earlier ones are emptied.
    const span = () => (v ? [h("code", {}, num(lo.x_from)), " … ", h("code", {}, num(hi.x_to))] : null);

    // --- the chart ---
    const chart = binadeChart({
      bands,
      view: v,
      compare: t ? { label: cmpLabel, bands: tBands } : null,
      onZoom: (z) => { location.hash = zoomHref(z); },
    });

    // What the zoomed range holds, summed exactly from the per-binade counts.
    const tally = (rows) => {
      let n = 0, same = 0, worst = null;
      for (const b of rows) {
        if (b.special || !within(b)) continue;
        n += (b.n_identical ?? 0) + (b.n_differ ?? 0) + (b.n_nonfinite ?? 0);
        same += b.n_identical ?? 0;
        const e = b.worst_rel_err;
        if (typeof e === "number" && Number.isFinite(e) && (worst === null || e > worst)) worst = e;
      }
      return { n, same, worst };
    };
    const summary = (label, x) =>
      h("span", {}, h("strong", {}, label), ` ${pct(x.n ? x.same / x.n : null)} bit-identical, worst rel err ${num(x.worst, 3)}`);
    const rangeLine = v
      ? h("p.range-line", {},
        h("span", {}, `In this range, ${v[1] - v[0]} of ${columns.length} binades (`, span(), `), ${int(tally(bands).n)} samples: `),
        summary(me, tally(bands)),
        t ? [" · ", summary(cmpLabel, tally(tBands))] : null)
      : null;

    put(slots.bands,
      h("div.panel-head", {},
        h("h2", {}, "Worst relative error by binade"),
        v ? h("button.reset", { onclick: () => { location.hash = zoomHref(null); } }, "Reset view") : null),
      h("p.note", {}, "The axis is the real line in bit-pattern order. Each bar is one binade, or, where they do not fit, the worst of several. ",
        h("strong", {}, "Drag across the chart to zoom"), " — the worst inputs and regions below follow the range.",
        t ? ` The line is ${cmpLabel}'s worst relative error over the same binades, against the same base R reference; it breaks where ${cmpLabel} was not swept and rests on the axis where it matches base R exactly.` : ""),
      chart.wrap ?? chart,
      rangeLine,
      h("div.chart-foot", {},
        h("div.key", {}, Object.values(BEHAVIOUR).map((b) =>
          h("span.key-item", {}, h("i", { class: b.cls }), b.label)), cmpKey),
        h("span.muted", {}, v ? `${v[1] - v[0]} of ${columns.length} binades` : `${columns.length} binades`)),
    );

    // --- the histogram: whole result only, and says so when zoomed ---
    put(slots.hist,
      h("h2", {}, "Distribution of relative error"),
      v ? h("p.note", {}, h("strong", {}, "Whole result, not the zoomed range."),
        " The sweep records this distribution per result rather than per binade, so it cannot follow the zoom; the line under the chart above gives the range's own figures.") : null,
      histChart(hist, t ? { label: cmpLabel, rows: tHist } : null),
      t ? h("div.chart-foot", {}, h("div.key", {},
        h("span.key-item", {}, h("i.k-anvl"), `${me} (bars)`), cmpKey)) : null,
    );

    // --- worst inputs ---
    const drawDetail = () => {
      const which = t && app.detailBackend === cmp ? cmp : r.backend;
      const rows = (which === r.backend ? detail : tDetail).filter(within);
      const shown = [...rows].sort((a, b) => (b.rel_err ?? -1) - (a.rel_err ?? -1)).slice(0, 25);
      const tabs = t
        ? h("div.seg", { role: "tablist", "aria-label": "whose worst inputs" },
          [r.backend, cmp].map((b) => h("button", {
            role: "tab",
            "aria-selected": String(which === b),
            class: which === b ? "on" : null,
            onclick: () => { app.detailBackend = b; drawDetail(); },
          }, backendLabel(b))))
        : null;
      put(slots.detail,
        h("h2", {}, "Worst inputs"),
        tabs,
        h("p.note", {},
          v ? ["The 25 largest relative errors in the zoomed range, ", span(), "."]
            : "The 25 largest relative errors across the whole sweep. Drag across the chart above to narrow to a range.",
          t ? " Each backend's worst inputs are its own, so the two lists are generally at different x." : ""),
        shown.length
          ? table([
            { label: "bits" }, { label: "x", align: "r" },
            { label: backendLabel(which), align: "r" }, { label: "base R", align: "r" },
            { label: "rel err", align: "r" }, { label: "ulp", align: "r" },
          ], shown.map((d) => h("tr", {},
            h("td", {}, h("code.bits", {}, d.bits ?? "")),
            h("td.r", {}, num(d.x)),
            h("td.r", {}, num(d.value)),
            h("td.r", {}, num(d.reference)),
            h("td.r", {}, num(d.rel_err, 3)),
            h("td.r", {}, num(d.ulp_err, 3)))))
          : h("p.muted", {}, v ? "No differing samples recorded in this range." : "No differing samples recorded here."),
      );
    };
    drawDetail();

    // --- regions ---
    const CLASS_NOTE = {
      unclassified: "not explained",
      nan: "input is NaN",
      subnormal: "subnormal, flushed to zero by XLA",
      below_support: "below the support of the distribution",
      above_support: "above the support of the distribution",
    };
    const overlaps = (x) => !inView || rangeKeys(x).some((k) => inView.has(k));
    const tagged = [
      ...ranges.filter(overlaps).map((x) => ({ ...x, be: r.backend })),
      ...tRanges.filter(overlaps).map((x) => ({ ...x, be: cmp })),
    ];
    const rsorted = tagged.sort((a, b) =>
      (a.be === r.backend ? 0 : 1) - (b.be === r.backend ? 0 : 1) ||
      (a.class === "unclassified" ? 0 : 1) - (b.class === "unclassified" ? 0 : 1) ||
      (b.n_patterns ?? 0) - (a.n_patterns ?? 0));
    put(slots.ranges,
      h("h2", {}, "Regions with no finite error"),
      h("p.note", {}, "Stretches of the input range where no finite relative error could be computed. All but ",
        h("em", {}, "not explained"), " have a known cause.",
        v ? [" Shown: regions that reach into ", span(), ", at their full extent."] : ""),
      rsorted.length
        ? table([
          ...(t ? [{ label: "backend" }] : []),
          { label: "from", align: "r" }, { label: "to", align: "r" },
          { label: "bit patterns", align: "r" }, { label: "cause" }],
          rsorted.map((x) => h("tr", { class: x.class === "unclassified" ? "row-warn" : null },
            t ? h("td", { class: x.be === cmp ? "cmp" : null }, backendLabel(x.be)) : null,
            h("td.r", {}, num(x.x_from)),
            h("td.r", {}, num(x.x_to)),
            h("td.r", {}, int(x.n_patterns)),
            h("td", {}, h(`span.pill.${x.class === "unclassified" ? "warn" : "ok"}`, {},
              CLASS_NOTE[x.class] ?? x.class)))))
        : h("p.muted", {}, v ? "None in this range." : "None."),
    );
  };

  draw(zoom);
  app.redrawCell = draw;
}

// --- wiring ------------------------------------------------------------

async function load(sourcePromise) {
  setStatus("loading artifact…");
  const source = await sourcePromise;
  app.store = await openStore(source);
  app.chartCell = null;
  renderHeader();
}

let lastPage = null;

function route() {
  if (!app.store) return;
  const r = parseRoute();
  // Zooming is a move within the page, not a move to another one.
  const page = `${r.view}|${r.spec ?? ""}|${r.cellId ?? ""}|${r.output ?? ""}`;
  const samePage = page === lastPage;
  lastPage = page;
  try {
    if (r.view === "spec") renderSpec(r.spec);
    else if (r.view === "cell") {
      // A new zoom on the same result redraws in place: no refetch, no flash.
      if (samePage && app.redrawCell) app.redrawCell(r.zoom);
      else renderCell(r.cellId, r.output, r.zoom);
    }
    else renderOverview();
  } catch (e) {
    console.error(e);
    setStatus(String(e.message ?? e), "error");
  }
  if (!samePage) scrollTo(0, 0);
}

addEventListener("hashchange", route);

(async function start() {
  app.deployed = await listDeployed();
  renderHeader();
  if (!app.deployed.length) {
    return setStatus(
      "No artifact is deployed with this page. Download one from the releases and open it with the file picker above.",
      "empty");
  }
  try {
    await load(urlSource(app.deployed[0].dir));
    route();
  } catch (e) {
    console.error(e);
    setStatus(String(e.message ?? e), "error");
  }
})();
