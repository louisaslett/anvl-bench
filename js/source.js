// Where the bytes come from. Two paths, both always available:
//
//   urlSource   the artifact the deploy workflow published next to the page.
//               Same-origin, so range requests work and one cell can be read
//               out of a 46 MB file. Release asset bytes are NOT reachable
//               from a browser (the signed redirect target sends no CORS
//               header), which is why the workflow copies them here instead.
//
//   fileSource  an artifact the user downloaded themselves and picked with a
//               file input. This is the only way to look at a version that is
//               not the deployed one, and it works even on file://, where
//               fetch does not.
//
// Both hand back the same thing: a manifest and a function returning an
// AsyncBuffer per table.

import { asyncBufferFromUrl } from "./hyparquet.js";

const TABLES = ["runs", "summary", "detail", "bands", "hist", "ranges"];

/** Wrap a File so hyparquet can range-read it without loading it all. */
const fileBuffer = (f) => ({
  byteLength: f.size,
  slice: (start, end) => f.slice(start, end ?? f.size).arrayBuffer(),
});

function memo(make) {
  const cache = new Map();
  return (key) => {
    if (!cache.has(key)) cache.set(key, make(key));
    return cache.get(key);
  };
}

/**
 * List the artifacts the site was deployed with. `data/index.json` is written
 * by the deploy workflow when more than one is published; a single artifact
 * needs no index, so its absence is normal rather than an error.
 */
export async function listDeployed() {
  try {
    const res = await fetch("data/index.json", { cache: "no-cache" });
    if (res.ok) {
      const idx = await res.json();
      if (Array.isArray(idx?.artifacts) && idx.artifacts.length) return idx.artifacts;
    }
  } catch { /* no index: fall through to the single-artifact case */ }
  try {
    const res = await fetch("data/manifest.json", { method: "HEAD", cache: "no-cache" });
    if (res.ok) return [{ id: "data", dir: "data" }];
  } catch { /* nothing deployed; the file picker is the only way in */ }
  return [];
}

export async function urlSource(dir = "data") {
  const base = dir.replace(/\/*$/, "/");
  const res = await fetch(base + "manifest.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`no manifest at ${base}manifest.json (${res.status})`);
  const manifest = await res.json();
  const buffer = memo((t) => asyncBufferFromUrl({ url: `${base}${t}.parquet` }));
  return { kind: "url", origin: base, manifest, buffer, has: (t) => TABLES.includes(t) };
}

export async function fileSource(fileList) {
  const files = new Map();
  let manifestFile = null;
  for (const f of fileList) {
    const name = f.name.toLowerCase();
    if (name === "manifest.json") manifestFile = f;
    const m = /^([a-z]+)\.parquet$/.exec(name);
    if (m) files.set(m[1], f);
  }
  if (!manifestFile) {
    throw new Error("no manifest.json among the selected files — select the whole artifact folder");
  }
  const manifest = JSON.parse(await manifestFile.text());
  const buffer = memo((t) => {
    const f = files.get(t);
    if (!f) throw new Error(`${t}.parquet was not among the selected files`);
    return fileBuffer(f);
  });
  return {
    kind: "file",
    origin: "local files",
    manifest,
    buffer,
    has: (t) => files.has(t),
  };
}
