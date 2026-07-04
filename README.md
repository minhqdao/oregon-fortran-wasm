# Oregon Fortran WASM

The Oregon Trail is a text-based educational computer game originally developed in 1971 by Don Rawitsch, Bill Heinemann, and Paul Dillenberger in HP Time-Shared BASIC. A revised version of the game was later published in the May/June 1978 issue of *Creative Computing* magazine.

This project is based on **OREGON 77**, an ANSI FORTRAN 77 port of the 1978 version of the game created by Philipp Engel and published in 2022.

The goal of this project is to explore native Fortran-to-WebAssembly compilation using modern Fortran compilers such as LFortran and LLVM Flang.

## Local Build

Make sure either `gfortran`, `lfortran`, or `flang` are installed on your system. Other compilers may work as well but have not been tested.

Then choose a command to compile the FORTRAN 77 source code:

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

Then run the resulting executable:

```bash
./oregon
```

## WebAssembly Build

WebAssembly artifacts are built automatically in the CI using GitHub Actions to ensure reproducible builds and a consistent toolchain configuration.

The current implementation targets native Fortran-to-WebAssembly compilation using LFortran and Emscripten.
