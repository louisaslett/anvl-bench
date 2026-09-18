// Charts, as hand-written SVG. There is no charting library here on purpose:
// the binade chart is a few thousand rectangles with a click handler, which is
// not a library's problem, and staying dependency-free keeps the page small.

import { MINUS, num, decadeTick } from "./fmt.js";

const NS = "http://www.w3.org/2000/svg";

const el = (name, attrs = {}, kids = []) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v !== null) n.setAttribute(k, v);
  for (const k of [].concat(kids)) n.append(k);
  return n;
};

/** Behaviour drives colour; the bar's height carries the size of the error. */
export const BEHAVIOUR = {
  "all identical": { cls: "b-identical", label: "all identical" },
  "identical + differ": { cls: "b-some", label: "identical + differ" },
  "all differ": { cls: "b-differ", label: "all differ" },
  "mixed, some non-finite": { cls: "b-nonfinite", label: "mixed, some non-finite" },
  "no finite error": { cls: "b-none", label: "no finite error" },
};
const behaviourClass = (b) => BEHAVIOUR[b]?.cls ?? "b-other";

const W = 1000;
const H = 260;
const PAD = { l: 58, r: 12, t: 26, b: 34 };
const PLOT_W = W - PAD.l - PAD.r;
const PLOT_H = H - PAD.t - PAD.b;

/**
 * Order the bands along the real line, which is also bit-pattern order:
 * most negative first (sign -1, highest binade) down through -0, then +0 up
 * to the largest positive. The top exponent field is not an interval -- it
 * holds both infinities and every NaN -- so it is pulled out and shown as a
 * marker at each end rather than as part of the axis.
 */
export function orderBands(bands) {
  const finite = bands.filter((b) => !b.special);
  const neg = finite.filter((b) => b.sign < 0).sort((a, b) => b.binade - a.binade);
  const pos = finite.filter((b) => b.sign > 0).sort((a, b) => a.binade - b.binade);
  return {
    columns: [...neg, ...pos],
    zeroAt: neg.length,
    special: bands.filter((b) => b.special),
  };
}

/**
 * Reduce a run of bands to one bar by taking the worst of them. Summarising
 * an accuracy chart by the maximum is the only reduction that cannot hide a
 * finding: a bucket is as bad as its worst member.
 */
function bucketOf(columns, from, to) {
  let err = null; // log10 of the worst relative error in the bucket
  let behaviour = null;
  let mixed = false;
  let worst = null;
  let n = 0;
  for (let i = from; i < to; i++) {
    const b = columns[i];
    // Height comes from the continuous worst_rel_err, not from the integer
    // decade: a whole sweep often sits inside a single decade, and rounding to
    // it would draw one flat block over real structure.
    const e = b.worst_rel_err;
    if (typeof e === "number" && e > 0 && Number.isFinite(e)) {
      const l = Math.log10(e);
      if (err === null || l > err) { err = l; worst = b; }
    }
    if (behaviour === null) behaviour = b.behaviour;
    else if (behaviour !== b.behaviour) mixed = true;
    n += (b.n_identical ?? 0) + (b.n_differ ?? 0) + (b.n_nonfinite ?? 0);
  }
  return {
    from,
    to,
    err,
    behaviour: mixed ? null : behaviour,
    worstBand: worst ?? columns[from],
    samples: n,
  };
}

/**
 * The binade chart. `view` is the index range currently shown; clicking a bar
 * that covers more than one binade zooms into it, and clicking a single
 * binade selects it. Callers re-render on any state change.
 */
export function binadeChart({ bands, view, selected, onSelect, onView }) {
  const { columns, zeroAt, special } = orderBands(bands);
  const wrap = document.createElement("div");
  wrap.className = "chart";

  if (!columns.length) {
    wrap.innerHTML = '<p class="muted">No band data for this result.</p>';
    return wrap;
  }

  const i0 = Math.max(0, view?.[0] ?? 0);
  const i1 = Math.min(columns.length, view?.[1] ?? columns.length);
  const n = i1 - i0;
  const nBuckets = Math.min(n, Math.floor(PLOT_W / 2));
  const buckets = [];
  for (let j = 0; j < nBuckets; j++) {
    const from = i0 + Math.floor((j * n) / nBuckets);
    const to = i0 + Math.floor(((j + 1) * n) / nBuckets);
    buckets.push(bucketOf(columns, from, Math.max(to, from + 1)));
  }

  // Scale to the errors actually present, so an f64 result whose errors all sit
  // near 1e-16 still fills the chart instead of flattening against the axis.
  const present = buckets.map((b) => b.err).filter((d) => d !== null);
  const dMax = present.length ? Math.ceil(Math.max(...present)) : 0;
  let dMin = present.length ? Math.floor(Math.min(...present)) : -1;
  if (dMax - dMin < 1) dMin = dMax - 1;
  const span = dMax - dMin;
  const y = (v) => PAD.t + PLOT_H - ((v - dMin) / span) * PLOT_H;

  const svg = el("svg", {
    viewBox: `0 0 ${W} ${H}`,
    class: "binade-svg",
    role: "img",
    "aria-label": "worst relative error by binade",
  });

  // y axis. Integer decades are too coarse when a whole sweep lives inside one
  // decade, which is the common case, so fall back to five even steps labelled
  // with the value itself.
  const ticks = [];
  if (span >= 3) {
    const every = Math.max(1, Math.ceil(span / 8));
    for (let d = dMax; d >= dMin; d -= every) ticks.push([d, decadeTick(d)]);
  } else {
    for (let i = 0; i <= 4; i++) {
      const v = dMin + (span * i) / 4;
      ticks.push([v, num(10 ** v, 2)]);
    }
  }
  for (const [v, label] of (present.length ? ticks : [])) {
    svg.append(
      el("line", { class: "grid", x1: PAD.l, x2: W - PAD.r, y1: y(v).toFixed(1), y2: y(v).toFixed(1) }),
      el("text", { class: "tick", x: PAD.l - 6, y: (y(v) + 3.5).toFixed(1), "text-anchor": "end" },
        document.createTextNode(label)),
    );
  }
  svg.append(el("text", { class: "axis-title", x: 6, y: 12 },
    document.createTextNode(present.length
      ? "worst relative error against base R"
      : "no finite error anywhere in this result")));

  // bars
  const bw = PLOT_W / nBuckets;
  const g = el("g", { class: "bars" });
  const hits = el("g", { class: "hits" });
  buckets.forEach((b, j) => {
    const x = PAD.l + j * bw;
    const isSel = selected !== null && selected !== undefined &&
      selected >= b.from && selected < b.to;
    const base = PAD.t + PLOT_H;
    const top = b.err === null ? base - 1.5 : y(b.err);
    const rect = el("rect", {
      class: `bar ${behaviourClass(b.behaviour)}${isSel ? " sel" : ""}`,
      x: x.toFixed(2),
      width: Math.max(bw - 0.15, 0.4).toFixed(2),
      y: top.toFixed(2),
      height: Math.max(base - top, 1.5).toFixed(2),
    });
    const wb = b.worstBand;
    const spanTxt = b.to - b.from > 1
      ? `${b.to - b.from} binades \u2014 click to zoom in`
      : `binade ${wb.binade} \u2014 click to inspect`;
    const tip =
      `${spanTxt}\n${wb.sign < 0 ? MINUS : "+"} ${num(Math.abs(wb.x_from))} \u2026 ${num(Math.abs(wb.x_to))}\n` +
      `worst rel err ${b.err === null ? "none" : num(wb.worst_rel_err, 3)}\n` +
      `${b.behaviour ?? "several behaviours"}`;
    rect.append(el("title", {}, document.createTextNode(tip)));
    g.append(rect);

    // A bar is under two pixels wide at full range, so clicking the bar itself
    // is a test of aim. The hit target is the full-height column behind it.
    const hit = el("rect", {
      class: "hit",
      x: x.toFixed(2),
      width: Math.max(bw, 2).toFixed(2),
      y: PAD.t,
      height: PLOT_H,
    });
    hit.append(el("title", {}, document.createTextNode(tip)));
    hit.addEventListener("click", () => {
      if (b.to - b.from > 1) onView([b.from, b.to]);
      else onSelect(b.from);
    });
    hits.append(hit);
  });
  svg.append(g, hits);

  // the sign change, when it is inside the view
  if (zeroAt > i0 && zeroAt < i1) {
    const x = PAD.l + ((zeroAt - i0) / n) * PLOT_W;
    svg.append(
      el("line", { class: "zero", x1: x.toFixed(1), x2: x.toFixed(1), y1: PAD.t, y2: PAD.t + PLOT_H }),
      el("text", { class: "tick", x: (x - 4).toFixed(1), y: H - 20, "text-anchor": "end" },
        document.createTextNode("x < 0")),
      el("text", { class: "tick", x: (x + 4).toFixed(1), y: H - 20 },
        document.createTextNode("x > 0")),
    );
  }

  // x axis: label the magnitude at each end of the visible range
  const edge = (i) => {
    const b = columns[i];
    const v = Math.abs(b.sign < 0 ? b.x_from : b.x_to);
    return (b.sign < 0 ? MINUS : "") + num(v, 2);
  };
  svg.append(
    el("line", { class: "axis", x1: PAD.l, x2: W - PAD.r, y1: PAD.t + PLOT_H, y2: PAD.t + PLOT_H }),
    el("text", { class: "tick", x: PAD.l, y: H - 8 }, document.createTextNode(edge(i0))),
    el("text", { class: "tick", x: W - PAD.r, y: H - 8, "text-anchor": "end" },
      document.createTextNode(edge(i1 - 1))),
  );

  wrap.append(svg);

  // The non-interval top exponent field, kept out of the axis on purpose.
  if (special.length) {
    const s = document.createElement("div");
    s.className = "special-row";
    s.append(Object.assign(document.createElement("span"), {
      className: "special-label",
      textContent: "top exponent field (±∞ and every NaN, not an interval):",
    }));
    for (const b of special) {
      const chip = document.createElement("button");
      chip.className = `chip ${behaviourClass(b.behaviour)}`;
      chip.textContent = `sign ${b.sign < 0 ? MINUS : "+"}: ${b.behaviour}` +
        (b.n_nonfinite ? `, ${b.n_nonfinite} non-finite` : "");
      chip.addEventListener("click", () => onSelect({ special: b }));
      s.append(chip);
    }
    wrap.append(s);
  }

  return { wrap, columns, zeroAt, nColumns: columns.length, view: [i0, i1] };
}

/** The error histogram: 25 decades, counts on a log scale. */
export function histChart(rows) {
  const wrap = document.createElement("div");
  wrap.className = "chart";
  const data = [...rows].sort((a, b) => a.decade - b.decade);
  if (!data.length || data.every((d) => !d.count)) {
    wrap.innerHTML = '<p class="muted">No finite errors recorded for this result.</p>';
    return wrap;
  }
  // Trim empty decades at both ends so the occupied range fills the chart.
  let lo = data.findIndex((d) => d.count > 0);
  let hi = data.length - 1 - [...data].reverse().findIndex((d) => d.count > 0);
  lo = Math.max(0, lo - 1);
  hi = Math.min(data.length - 1, hi + 1);
  const shown = data.slice(lo, hi + 1);

  const h = 150;
  const pad = { l: 52, r: 12, t: 10, b: 30 };
  const pw = W - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  const max = Math.max(...shown.map((d) => d.count));
  const scale = (c) => (c <= 0 ? 0 : (Math.log10(c + 1) / Math.log10(max + 1)) * ph);

  const svg = el("svg", { viewBox: `0 0 ${W} ${h}`, class: "hist-svg", role: "img",
    "aria-label": "distribution of relative error by decade" });
  svg.append(el("text", { class: "axis-title", x: 6, y: pad.t + 4 },
    document.createTextNode("samples (log)")));
  const bw = pw / shown.length;
  shown.forEach((d, j) => {
    const bh = scale(d.count);
    const x = pad.l + j * bw;
    const rect = el("rect", {
      class: "hbar", x: (x + bw * 0.1).toFixed(2), width: (bw * 0.8).toFixed(2),
      y: (pad.t + ph - bh).toFixed(2), height: Math.max(bh, d.count > 0 ? 1 : 0).toFixed(2),
    });
    rect.append(el("title", {}, document.createTextNode(
      `rel err 1e${String(d.decade).replace("-", MINUS)} – 1e${String(d.decade + 1).replace("-", MINUS)}\n` +
      `${d.count.toLocaleString("en-US")} samples`)));
    svg.append(rect);
    if (shown.length <= 14 || j % 2 === 0) {
      svg.append(el("text", { class: "tick", x: (x + bw / 2).toFixed(1), y: h - 10,
        "text-anchor": "middle" }, document.createTextNode(decadeTick(d.decade))));
    }
  });
  svg.append(el("line", { class: "axis", x1: pad.l, x2: W - pad.r,
    y1: pad.t + ph, y2: pad.t + ph }));
  wrap.append(svg);
  return wrap;
}
