// The domain layer: what the site knows about an artifact, and how little of
// it has to be fetched to answer a question.
//
// Read strategy, in three tiers:
//
//   eager    manifest.json + summary.parquet + runs.parquet. ~32 kB, two
//            round trips, and it is enough to render the overview and every
//            function page without touching another byte.
//   whole    hist and ranges, ~265 kB between them, read once on the first
//            leaf page and kept.
//   by cell  detail (46 MB) and bands (7.4 MB) are sorted by cell with a row
//            group boundary at each cell, and the footer carries exact
//            min/max statistics on cell_id. So the row group holding a cell
//            is found from the footer alone and read on its own: measured at
//            ~2% of detail.parquet for one cell.

import { parquetMetadataAsync, parquetReadObjects } from "./hyparquet.js";

const EAGER = ["summary", "runs"];
const WHOLE = ["hist", "ranges"];
const BY_CELL = ["detail", "bands"];

const SEP = "␟"; // never appears in a cell_id or an output name

/** Parquet statistics come back as bytes or as a string depending on writer. */
function asText(v) {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return new TextDecoder().decode(v);
  if (ArrayBuffer.isView(v)) return new TextDecoder().decode(new Uint8Array(v.buffer));
  return String(v);
}

export async function openStore(source) {
  const manifest = source.manifest;
  const meta = new Map();
  const whole = new Map();

  const metadata = async (table) => {
    if (!meta.has(table)) meta.set(table, parquetMetadataAsync(await source.buffer(table)));
    return meta.get(table);
  };

  const readAll = async (table, columns) =>
    parquetReadObjects({ file: await source.buffer(table), columns });

  const [summary, runs] = await Promise.all([
    readAll("summary"),
    // The fingerprint is nice to have, not load-bearing: a partial artifact
    // (just manifest + summary) should still open.
    source.has("runs") ? readAll("runs").catch(() => []) : [],
  ]);

  /**
   * Row range covering one cell, from the footer statistics. Returns null if
   * the writer left no statistics, in which case the caller falls back to
   * reading the table whole rather than returning a wrong answer.
   */
  async function cellRange(table, cellId) {
    const md = await metadata(table);
    let row = 0;
    let lo = null;
    let hi = null;
    for (const g of md.row_groups) {
      const n = Number(g.num_rows);
      const col = g.columns.find(
        (c) => (c.meta_data?.path_in_schema ?? []).join(".") === "cell_id",
      );
      const st = col?.meta_data?.statistics;
      const min = asText(st?.min_value);
      const max = asText(st?.max_value);
      if (min === undefined || max === undefined) return null;
      // A cell occupies one row group today, but tolerate it spanning several.
      if (min <= cellId && cellId <= max) {
        if (lo === null) lo = row;
        hi = row + n;
      } else if (lo !== null) {
        break;
      }
      row += n;
    }
    return lo === null ? { rowStart: 0, rowEnd: 0 } : { rowStart: lo, rowEnd: hi };
  }

  /** Every row of `table` belonging to one cell (all of its outputs). */
  async function cellRows(table, cellId, columns) {
    if (!source.has(table)) return [];
    if (WHOLE.includes(table)) {
      if (!whole.has(table)) whole.set(table, readAll(table));
      return (await whole.get(table)).filter((r) => r.cell_id === cellId);
    }
    const range = await cellRange(table, cellId);
    if (range === null) {
      // No statistics to seek with. Correct, just slow, and says so.
      console.warn(`${table}.parquet has no cell_id statistics; reading it whole`);
      if (!whole.has(table)) whole.set(table, readAll(table, columns));
      return (await whole.get(table)).filter((r) => r.cell_id === cellId);
    }
    if (range.rowEnd === range.rowStart) return [];
    const rows = await parquetReadObjects({
      file: await source.buffer(table),
      columns,
      rowStart: range.rowStart,
      rowEnd: range.rowEnd,
    });
    // The row group may hold neighbours if a future writer packs cells
    // together, so filter rather than trust the boundary.
    return rows.filter((r) => r.cell_id === cellId);
  }

  // --- indexes over the summary, which is the whole navigable structure ---

  const results = summary.map((r) => ({ ...r, key: r.cell_id + SEP + r.output }));
  const byKey = new Map(results.map((r) => [r.key, r]));

  const specs = [...new Set(results.map((r) => r.spec))].sort();
  const bySpec = new Map(specs.map((s) => [s, results.filter((r) => r.spec === s)]));
  const runById = new Map(runs.map((r) => [r.run_id, r]));

  return {
    source,
    manifest,
    summary: results,
    runs,
    runById,
    specs,
    bySpec: (s) => bySpec.get(s) ?? [],
    result: (cellId, output) => byKey.get(cellId + SEP + output),
    cellRows,
    tables: { EAGER, WHOLE, BY_CELL },
  };
}

/** Does this result disagree with base R somewhere nothing explains? */
export const isUnexplained = (r) =>
  r.unexplained_from !== null && r.unexplained_from !== undefined;
