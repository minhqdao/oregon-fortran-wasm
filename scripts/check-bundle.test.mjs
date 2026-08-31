// Verifies the deploy bundle produced by scripts/bundle-web.sh.
//
// The bundling exists to make each deployed page load atomically one
// deploy (GH Pages' fixed max-age=600 otherwise allows stale entry
// modules to mix with fresh siblings). These checks fail CI when a
// change reintroduces a multi-file module graph or drops a runtime file.
//
//   node scripts/check-bundle.test.mjs [distDir]
//
// Exits non-zero on the first violated expectation.

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const distDir = process.argv[2] ?? "dist";

test("deploy bundle is self-contained", () => {
  const html = readFileSync(join(distDir, "index.html"), "utf8");
  const launcher = readFileSync(join(distDir, "launcher.js"), "utf8");
  const worker = readFileSync(join(distDir, "runner.worker.js"), "utf8");

  // The page must reference the launcher with a build-id query (busts the
  // host's fixed max-age after deploys).
  const entry = html.match(/src="\.\/launcher\.js\?v=([0-9a-f]+)"/);
  assert.ok(entry, "index.html must load ./launcher.js?v=<build-id>");
  const buildId = entry[1];
  assert.match(buildId, /^[0-9a-f]{12}$/, "build id is a 12-hex-char hash");

  // A single-file module graph: any surviving static or bare import
  // reintroduces the multi-file skew the bundling exists to remove.
  assert.doesNotMatch(
    launcher,
    /^import\s/m,
    "bundled launcher.js must not start any static import statement",
  );
  assert.doesNotMatch(
    worker,
    /^import\s/m,
    "bundled runner.worker.js must not start any static import statement",
  );
  assert.doesNotMatch(
    launcher,
    /\bfrom\s+["'][^"']+["']/,
    "bundled launcher.js must not contain import-from specifiers",
  );

  // The launcher keeps its runtime-URL derivations for the worker and the
  // wasm glue. Resolving them against launcher.js?v=<id> deliberately drops
  // the query -- only the entry is versioned; see the note in
  // scripts/bundle-web.sh before "propagating" anything.
  assert.match(
    launcher,
    /new URL\("\.\/runner\.worker\.js", import\.meta\.url\)/,
    "worker URL must be derived from import.meta.url",
  );
  assert.match(
    launcher,
    /new URL\("\.\/oregon\.js", import\.meta\.url\)/,
    "wasm URL must be derived from import.meta.url",
  );

  // The inline boot guard survived the sed-based entry rewrite.
  assert.match(
    html,
    /oregon-module-reload/,
    "index.html must keep the boot-phase guard script",
  );
  assert.match(
    html,
    /Still loading after 20 seconds/,
    "index.html must keep the boot watchdog",
  );

  // Everything the page references at runtime must exist in the bundle.
  for (const file of [
    "launcher.js",
    "runner.worker.js",
    "oregon.js",
    "oregon.wasm",
    "coi-serviceworker.js",
    "favicon.ico",
    "favicon.svg",
    "favicon-16.png",
    "favicon-32.png",
    "favicon-64.png",
    "apple-touch-icon.png",
  ]) {
    assert.ok(
      existsSync(join(distDir, file)),
      `bundle is missing ${file} referenced by index.html`,
    );
  }

  // The deployed page must not be able to observe a mixed module graph:
  // no terminal-*.js / runner-protocol.js files are shipped.
  for (const file of [
    "terminal-scroll.js",
    "terminal-input.js",
    "terminal-output.js",
    "terminal-render.js",
    "terminal-selection.js",
    "runner-protocol.js",
  ]) {
    assert.ok(
      !existsSync(join(distDir, file)),
      `bundle must not ship the modular source ${file}`,
    );
  }
});
