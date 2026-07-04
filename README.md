# Oregon Fortran WASM

The Oregon Trail is a text-based educational computer game originally developed in 1971 by Don Rawitsch, Bill Heinemann, and Paul Dillenberger in HP Time-Shared BASIC. A revised version of the game was later published in the May/June 1978 issue of *Creative Computing* magazine.

This project is based on **OREGON 77**, an ANSI FORTRAN 77 port of the 1978 version of the game created by Philipp Engel and published in 2022.

The goal of this project is to explore native Fortran-to-WebAssembly compilation using modern Fortran compilers such as LFortran and LLVM Flang.

## Development

### Local Compilation

The original FORTRAN 77 source can be compiled locally using `gfortran`:

```bash
gfortran src/oregon.f -o oregon
```

Run the resulting executable:

```bash
./oregon
```
