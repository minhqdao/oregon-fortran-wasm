# Oregon Fortran WASM

[![CI](https://img.shields.io/github/actions/workflow/status/minhqdao/oregon-fortran-wasm/ci.yml?logo=github&label=CI)](https://github.com/minhqdao/oregon-fortran-wasm/actions/workflows/ci.yml)
[![Play online](https://img.shields.io/website?url=https%3A%2F%2Fminhqdao.github.io%2Foregon-fortran-wasm%2F&logo=webassembly&label=play%20online)](https://minhqdao.github.io/oregon-fortran-wasm/)
[![License](https://img.shields.io/github/license/minhqdao/oregon-fortran-wasm)](LICENSE)

The Oregon Trail is a text-based educational computer game originally developed in 1971 by Don Rawitsch, Bill Heinemann, and Paul Dillenberger in HP Time-Shared BASIC. A revised version of the game was later published in the May/June 1978 issue of _Creative Computing_ magazine.

This project is based on **OREGON 77**, an ANSI FORTRAN 77 port of the 1978 version of the game created by Philipp Engel and published in 2022 under the ISC license.

The goal of this project is to explore Fortran-to-WebAssembly compilation using modern Fortran compilers such as LFortran and LLVM Flang. The game is currently built with LFortran and Emscripten and runs entirely in the browser — [play it online](https://minhqdao.github.io/oregon-fortran-wasm/).

## Native Build

Requires `gfortran`, `lfortran`, or `flang`; other compilers may work but have not been tested.

```bash
# gfortran
gfortran src/oregon.f src/oregon_time.f -o oregon

# lfortran
lfortran --fixed-form --implicit-interface --implicit-typing src/oregon.f src/oregon_time.f -o oregon

# flang
flang src/oregon.f src/oregon_time.f -o oregon
```

Run the game with `./oregon`.

## WebAssembly Build

Prebuilt `web/oregon.js` and `web/oregon.wasm` (LFortran 0.65.0, Emscripten 6.0.9) are committed, so you can run the web version without a toolchain; CI rebuilds them for each deployment. To rebuild them yourself, install [LFortran](https://lfortran.org/) and [Emscripten](https://emscripten.org/), make sure both are on your `PATH`, and run:

```bash
scripts/build-web.sh
```

To play locally, start the included web server and open http://localhost:8080:

```bash
node scripts/dev-server.mjs 8080
```

### Deployment

Every push to `main` is checked and deployed to GitHub Pages automatically by GitHub Actions — there is nothing to release by hand. The published site is a bundled, self-contained build of the game, so each update goes live as one consistent deploy.

## Checks

Run the regression suite, the browser smoke tests and the typecheck with:

```bash
node scripts/run-tests.mjs
scripts/browser-smoke.sh
scripts/typecheck.sh
```

## License

This repository makes no copyright claim on the original game source. The FORTRAN port is OREGON 77 by Philipp Engel, licensed under the ISC license. All additions in this repository are licensed under the [ISC License](LICENSE).
