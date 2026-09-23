// @ts-check
//
// The generic runner worker lives in the terminal-shell npm package. This
// entry exists so the deploy bundle keeps a stable worker URL next to the
// launcher: esbuild inlines the package module -- onmessage wiring
// included -- into this file.
//
// The import is relative (see web/launcher.js): document import maps do
// not apply inside workers, so a bare specifier would fail here.
import "../node_modules/terminal-shell/src/runner-worker.js";
