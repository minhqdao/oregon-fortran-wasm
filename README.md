# Oregon Fortran WASM

The Oregon Trail is a text-based educational computer game originally developed in 1971 by Don Rawitsch, Bill Heinemann, and Paul Dillenberger in HP Time-Shared BASIC. A revised version of the game was later published in the May/June 1978 issue of *Creative Computing* magazine.

This project is based on **OREGON 77**, an ANSI FORTRAN 77 port of the 1978 version of the game created by Philipp Engel and published in 2022 under the ISC license.

The goal of this project is to explore native Fortran-to-WebAssembly compilation using modern Fortran compilers such as LFortran and LLVM Flang.

## Native Build

Make sure either `gfortran`, `lfortran`, or `flang` are installed on your system. Other compilers may work as well but have not been tested.

Choose a command to compile the FORTRAN 77 source code:

#### gfortran

```bash
gfortran src/oregon.f src/oregon_time.f -o oregon
```

#### lfortran

```bash
lfortran --fixed-form --implicit-interface --implicit-typing src/oregon.f src/oregon_time.f -o oregon
```

#### flang

```bash
flang src/oregon.f src/oregon_time.f -o oregon
```

Start the game by running the executable:

```bash
./oregon
```

## WebAssembly Build

The WebAssembly build requires [LFortran](https://lfortran.org/) and [Emscripten](https://emscripten.org/). Install LFortran (e.g. with `conda install -c conda-forge lfortran`) and Emscripten, and make sure `lfortran` and `emcc` are on your `PATH`. The build is known to work with LFortran 0.64.0 and Emscripten 6.0.8, but other recent versions should work as well.

```bash
scripts/build-web.sh
```

The script compiles the FORTRAN sources with `lfortran` and links with `emcc`, emitting `web/oregon.js` and `web/oregon.wasm`.

Then run the game with [Node.js](https://nodejs.org/en/download/):

```
node scripts/dev-server.mjs 8080
```
