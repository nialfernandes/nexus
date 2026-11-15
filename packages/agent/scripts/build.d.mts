/** Builds the library to one ES module at `outfile`: nothing imported, libsodium's WebAssembly inside. */
export function buildLibrary(outfile: string): Promise<void>;
/** Builds the nexus-agent command, a Node program, at `outfile`. */
export function buildCommand(outfile: string): Promise<void>;
/** SHA-256 of a file, as 64 lower case hex characters. */
export function sha256Of(file: string): Promise<string>;
