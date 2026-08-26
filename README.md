# Oregon Fortran WASM

The Oregon Trail is a text-based educational computer game originally developed in 1971 by Don Rawitsch, Bill Heinemann, and Paul Dillenberger in HP Time-Shared BASIC. A revised version of the game was later published in the May/June 1978 issue of *Creative Computing* magazine.

This project is based on **OREGON 77**, an ANSI FORTRAN 77 port of the 1978 version of the game created by Philipp Engel and published in 2022 under the ISC license.

The goal of this project is to explore native Fortran-to-WebAssembly compilation using modern Fortran compilers such as LFortran and LLVM Flang.

## Local Build

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

The currently working WASM build uses LFortran and Emscripten.

To build locally, run:

```bash
scripts/build-web.sh
```

The script looks for `lfortran` and `emcc` in `tools/` and on your `PATH` (overrides: `LFORTRAN`, `EMCC`). If neither is found, it provisions pinned toolchain versions into `tools/` on the first run: LFortran 0.64.0, installed from conda-forge via micromamba (LFortran publishes no binary releases), and Emscripten 6.0.8, via the emsdk repository. Provisioning requires `git`, `python3`, `curl`, `tar`, and `bzip2`.

The build emits `web/oregon.js` and `web/oregon.wasm`.
