// Minimal static server for local development.
//
// It exists because Python's http.server does not implement Range requests,
// and the whole read strategy here depends on them: hyparquet fetches a few
// row groups out of a 46 MB Parquet file rather than the file. GitHub Pages
// serves `accept-ranges: bytes`, so this mirrors production.
//
//   node tools/serve.mjs [port]

import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const port = Number(process.argv[2] ?? 8099);

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".parquet": "application/vnd.apache.parquet",
  ".svg": "image/svg+xml",
};

createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith("/")) rel += "index.html";
  // Reject traversal before it reaches the filesystem.
  const path = join(root, normalize(rel).replace(/^(\.\.[/\\])+/, ""));

  let stat;
  try {
    stat = statSync(path);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("404");
  }
  if (stat.isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("404");
  }

  const type = types[extname(path)] ?? "application/octet-stream";
  const base = {
    "content-type": type,
    "accept-ranges": "bytes",
    "cache-control": "no-cache",
  };

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range) {
    const [, rawStart, rawEnd] = range;
    const start = rawStart === "" ? stat.size - Number(rawEnd) : Number(rawStart);
    const end = rawStart === "" || rawEnd === "" ? stat.size - 1 : Number(rawEnd);
    if (!(start >= 0 && end < stat.size && start <= end)) {
      res.writeHead(416, { ...base, "content-range": `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, {
      ...base,
      "content-range": `bytes ${start}-${end}/${stat.size}`,
      "content-length": end - start + 1,
    });
    return createReadStream(path, { start, end }).pipe(res);
  }

  res.writeHead(200, { ...base, "content-length": stat.size });
  if (req.method === "HEAD") return res.end();
  createReadStream(path).pipe(res);
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
