// Router and views.
//
// The URL is the whole of the navigable state, so any finding on this site can
// be linked from an issue:
//
//   #/                                             overview
//   #/spec/nv_qnorm                                one function
//   #/cell/<cell_id>/<output>[?b=<index>]          one result, one binade
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
const table = (headers, rows) =>
  h("div.table-wrap", { tabindex: "0", role: "region", "aria-label": "results" },
    h("table.grid", {},
      h("thead", {}, h("tr", {}, headers.map((c) =>
        h("th", { class: c.align === "r" ? "r" : null, title: c.hint ?? null }, c.label ?? c)))),
      h("tbody", {}, rows)));

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
    return {
      view: "cell",
      cellId: parts[1],
      output: parts[2],
      binade: q.has("b") ? Number(q.get("b")) : null,
    };
  }
  return { view: "overview" };
}

// --- state -------------------------------------------------------------

const app = {
  store: null,
  deployed: [],
  chartView: null, // zoom range, reset whenever the result changes
  chartCell: null,
};

const main = () => document.getElementById("main");
const setStatus = (msg, cls = "") => {
  main().replaceChildren(h(`p.status.${cls}`.replace(/\.$/, ""), {}, msg));
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
  bar.replaceChildren(...kids);
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
  main().replaceChildren(...out);
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
  if (!rows.length) return setStatus(`No results for ${spec} in this artifact.`, "error");
  const a = aggregate(rows);

  const sorted = [...rows].sort(SORTS[specSort] ?? SORTS.worst);
  const body = sorted.map((r) => h("tr", { class: isUnexplained(r) ? "row-warn" : null },
    h("td", {}, h("a", { href: cellHref(r.cell_id, r.output) },
      h("span.dt", {}, r.dtype), " ", r.kind, " ", h("span.muted", {}, r.param_set))),
    h("td", {}, flagList(r.flags).map((f) => h("span.chip.flag", {}, f))),
    h("td", {}, h("code", {}, r.output)),
    h("td.r", {}, num(r.worst_rel_err, 3)),
    h("td.r", {}, num(r.worst_ulp_err, 3)),
    h("td.r", {}, pct(r.n_exact / r.n_samples)),
    h("td.r.muted", {}, int(r.n_samples)),
    h("td", {}, isUnexplained(r)
      ? h("a.pill.warn", { href: cellHref(r.cell_id, r.output) },
        `${num(Math.abs(r.unexplained_from), 2)} … ${num(Math.abs(r.unexplained_to), 2)}`)
      : h("span.pill.ok", {}, "✓"))));

  const sortSel = h("select", { onchange: (e) => { specSort = e.target.value; renderSpec(spec); } },
    [["worst", "worst relative error"], ["ulp", "worst ulp error"],
     ["exact", "least bit-identical"], ["name", "name"]].map(([v, l]) =>
      h("option", { value: v, selected: v === specSort }, l)));

  main().replaceChildren(
    h("nav.crumbs", {}, h("a", { href: "#/" }, "overview"), " / ", h("span", {}, spec)),
    h("h1", {}, spec),
    h("p.lede", {}, `${a.n} results, ${int(a.samples)} samples. `,
      a.unexplained
        ? h("strong", {}, `${a.unexplained} with unexplained disagreement.`)
        : "All disagreement with base R is explained."),
    h("label.field", {}, "Sort by ", sortSel),
    table([
      { label: "cell", hint: "precision, value or gradient, parameter set" },
      "flags",
      { label: "output", hint: "value, or the argument differentiated" },
      { label: "worst rel err", align: "r" }, { label: "worst ulp", align: "r" },
      { label: "bit-identical", align: "r" }, { label: "samples", align: "r" },
      { label: "unexplained", hint: "range of x where disagreement is not explained by NaN, subnormals or the edge of the support" },
    ], body));
}

// --- one result --------------------------------------------------------

async function renderCell(cellId, output, binade) {
  const s = app.store;
  const r = s.result(cellId, output);
  if (!r) return setStatus(`No result for ${cellId} / ${output} in this artifact.`, "error");
  const parts = cellParts(cellId);

  // Zooming is per result; moving to another one starts from the full range.
  const key = `${cellId}/${output}`;
  if (app.chartCell !== key) { app.chartCell = key; app.chartView = null; }

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
      h("span.chip", {}, parts.backend)),
    h("dl.stats", {}, [
      ["worst relative error", num(r.worst_rel_err)],
      ["worst ulp error", num(r.worst_ulp_err)],
      ["bit-identical", [pct(r.n_exact / r.n_samples),
        h("span.muted", {}, ` of ${int(r.n_samples)}`)]],
      ["worst at x", [num(r.worst_x), " ", h("code.bits", {}, r.worst_bits ?? "")]],
      ["anvl there", num(r.worst_value)],
      ["base R there", num(r.worst_reference)],
    ].map(([k, v]) => h("div.stat", {}, h("dt", {}, k), h("dd", {}, v)))),
    isUnexplained(r)
      ? h("div.callout.warn", {},
        h("strong", {}, "Unexplained disagreement"),
        h("p", {}, "Between ", h("code", {}, num(r.unexplained_from)), " and ",
          h("code", {}, num(r.unexplained_to)),
          " anvl and base R differ for reasons not accounted for by NaN, subnormal flush-to-zero, or the edges of the support. ",
          h("span.muted", {}, "Which of the two is closer to the true value is a separate question; base R is the reference, not an oracle.")))
      : null,
  ];

  const slots = {
    bands: h("section.panel", {}, h("h2", {}, "Worst relative error by binade"), h("p.status", {}, "reading…")),
    hist: h("section.panel", {}, h("h2", {}, "Distribution of relative error"), h("p.status", {}, "reading…")),
    detail: h("section.panel", {}, h("h2", {}, "Worst inputs"), h("p.status", {}, "reading…")),
    ranges: h("section.panel", {}, h("h2", {}, "Regions with no finite error"), h("p.status", {}, "reading…")),
  };
  main().replaceChildren(
    ...head.filter(Boolean), slots.bands, slots.hist, slots.detail, slots.ranges);

  const forOutput = (rows) => rows.filter((x) => x.output === output);
  const [bands, hist, detail, ranges] = await Promise.all([
    s.cellRows("bands", cellId).then(forOutput),
    s.cellRows("hist", cellId).then(forOutput),
    s.cellRows("detail", cellId).then(forOutput),
    s.cellRows("ranges", cellId).then(forOutput),
  ]);

  const drawBands = () => {
    const chart = binadeChart({
      bands,
      view: app.chartView,
      selected: binade,
      onSelect: (i) => {
        if (i && i.special) return; // the top field has no index on the axis
        const idx = typeof i === "number" ? i : null;
        location.hash = cellHref(cellId, output, idx === null ? "" : `?b=${idx}`);
      },
      onView: (v) => { app.chartView = v; drawBands(); },
    });
    const zoomed = app.chartView !== null;
    slots.bands.replaceChildren(
      h("h2", {}, "Worst relative error by binade"),
      h("p.note", {}, "The axis is the real line in bit-pattern order. Each bar is one binade, or, where they do not fit, the worst of several — click to zoom in, then click a single binade to inspect it."),
      chart.wrap ?? chart,
      h("div.chart-foot", {},
        h("div.key", {}, Object.values(BEHAVIOUR).map((b) =>
          h("span.key-item", {}, h("i", { class: b.cls }), b.label))),
        zoomed
          ? h("button.link", { onclick: () => { app.chartView = null; drawBands(); } },
            `showing ${app.chartView[1] - app.chartView[0]} of ${chart.nColumns} binades — reset`)
          : h("span.muted", {}, `${chart.nColumns} binades`)),
    );
  };
  drawBands();

  slots.hist.replaceChildren(h("h2", {}, "Distribution of relative error"), histChart(hist));

  // The worst inputs, narrowed to the selected binade when there is one.
  const ordered = bands.filter((b) => !b.special)
    .sort((a, b) => (a.sign < 0 ? -1 : 1) - (b.sign < 0 ? -1 : 1) ||
      (a.sign < 0 ? b.binade - a.binade : a.binade - b.binade));
  const sel = binade === null ? null : (() => {
    const { columns } = { columns: ordered };
    return columns[binade] ?? null;
  })();
  const shown = sel
    ? detail.filter((d) => d.binade === sel.binade && d.sign === sel.sign)
    : [...detail].sort((a, b) => (b.rel_err ?? -1) - (a.rel_err ?? -1)).slice(0, 25);

  slots.detail.replaceChildren(
    h("h2", {}, "Worst inputs"),
    sel
      ? h("p.note", {}, `Binade ${sel.binade}, ${sel.sign < 0 ? "negative" : "positive"}: `,
        h("code", {}, num(sel.x_from)), " … ", h("code", {}, num(sel.x_to)), ". ",
        h("a", { href: cellHref(cellId, output) }, "show the worst overall instead"))
      : h("p.note", {}, "The 25 largest relative errors across the whole sweep. Click a binade in the chart above to narrow to it."),
    shown.length
      ? table([
        { label: "bits" }, { label: "x", align: "r" },
        { label: "anvl", align: "r" }, { label: "base R", align: "r" },
        { label: "rel err", align: "r" }, { label: "ulp", align: "r" },
      ], shown.slice(0, 200).map((d) => h("tr", {},
        h("td", {}, h("code.bits", {}, d.bits ?? "")),
        h("td.r", {}, num(d.x)),
        h("td.r", {}, num(d.value)),
        h("td.r", {}, num(d.reference)),
        h("td.r", {}, num(d.rel_err, 3)),
        h("td.r", {}, num(d.ulp_err, 3)))))
      : h("p.muted", {}, "No differing samples recorded here."),
  );

  const CLASS_NOTE = {
    unclassified: "not explained",
    nan: "input is NaN",
    subnormal: "subnormal, flushed to zero by XLA",
    below_support: "below the support of the distribution",
    above_support: "above the support of the distribution",
  };
  const rsorted = [...ranges].sort((a, b) =>
    (a.class === "unclassified" ? 0 : 1) - (b.class === "unclassified" ? 0 : 1) ||
    (b.n_patterns ?? 0) - (a.n_patterns ?? 0));
  slots.ranges.replaceChildren(
    h("h2", {}, "Regions with no finite error"),
    h("p.note", {}, "Stretches of the input range where no finite relative error could be computed. All but ",
      h("em", {}, "not explained"), " have a known cause."),
    rsorted.length
      ? table([{ label: "from", align: "r" }, { label: "to", align: "r" },
        { label: "bit patterns", align: "r" }, { label: "cause" }],
        rsorted.map((x) => h("tr", { class: x.class === "unclassified" ? "row-warn" : null },
          h("td.r", {}, num(x.x_from)),
          h("td.r", {}, num(x.x_to)),
          h("td.r", {}, int(x.n_patterns)),
          h("td", {}, h(`span.pill.${x.class === "unclassified" ? "warn" : "ok"}`, {},
            CLASS_NOTE[x.class] ?? x.class)))))
      : h("p.muted", {}, "None."),
  );
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
  // Picking a binade is a move within the page, not a move to another one.
  const page = `${r.view}|${r.spec ?? ""}|${r.cellId ?? ""}|${r.output ?? ""}`;
  const samePage = page === lastPage;
  lastPage = page;
  try {
    if (r.view === "spec") renderSpec(r.spec);
    else if (r.view === "cell") renderCell(r.cellId, r.output, r.binade);
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
