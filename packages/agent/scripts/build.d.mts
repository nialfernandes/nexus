/** Builds the library to one ES module at `outfile`: nothing imported, libsodium's WebAssembly inside, and the same WebAssembly as a file beside it (`wasmFileFor`). */
export function buildLibrary(outfile: string): Promise<void>;
/** Where the WebAssembly goes for a library written to `outfile`: the same name with .wasm in place of .js, beside it. */
export function wasmFileFor(outfile: string): string;
/** Builds the nexus-agent command, a Node program, at `outfile`. */
export function buildCommand(outfile: string): Promise<void>;
/** SHA-256 of a file, as 64 lower case hex characters. */
export function sha256Of(file: string): Promise<string>;
