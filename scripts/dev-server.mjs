// Static file server for the web build that sets the COOP/COEP headers
// required for SharedArrayBuffer, mirroring what coi-serviceworker.js does
// for hosts that cannot send headers themselves (e.g. GitHub Pages).
//
// Usage: node scripts/dev-server.mjs [port] [rootDir]
//   rootDir defaults to web/; pass dist/ to preview the deploy bundle.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.argv[3]
  ? fileURLToPath(new URL(process.argv[3], `file://${process.cwd()}/`))
  : fileURLToPath(new URL("../web", import.meta.url));
const port = Number(process.argv[2]) || 8080;
// The web sources import the terminal-shell npm package by relative path
// (../node_modules/...); the browser clamps that import to /node_modules/...
// under the served root, so the installed package is mounted there. (The
// bundled dist/ inlines the package, so the mount only matters for this
// dev server.)
const modulesRoot = fileURLToPath(new URL("../node_modules", import.meta.url));

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith("/")) pathname += "index.html";
    const [serveRoot, servePath] = pathname.startsWith("/node_modules/")
      ? [modulesRoot, pathname.slice("/node_modules".length + 1)] // "/node_modules/x" -> "/x" under node_modules/
      : [root, pathname];
    const filePath = normalize(join(serveRoot, servePath));
    if (!filePath.startsWith(serveRoot + sep)) {
      response.writeHead(403).end();
      return;
    }
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cache-Control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
}).listen(port, () => {
  console.log(`Serving ${root} at http://localhost:${port}`);
});
