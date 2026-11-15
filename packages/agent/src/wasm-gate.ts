// How libsodium's WebAssembly is started when the library is built to one file (scripts/build.mjs).
//
// libsodium makes its WebAssembly from a text of base64 that is inside its own code, with `WebAssembly.instantiate(bytes)`. A Cloudflare
// Worker refuses to make code from bytes ("Wasm code generation disallowed by embedder"); it takes a module that was compiled before
// the Worker started, which is what importing a .wasm file gives it. So the built library can be handed that module (`AgentOptions.wasm`),
// and then it never makes code from bytes.
//
// libsodium starts as soon as the file is loaded, before any code of the agent's has run, so it cannot be told about a module then. The
// build therefore puts one call into libsodium's start-up, to `chooseWasm` below, and libsodium waits there until the vault says the
// time has come: `startLibsodium` is called by `AgentVault` before its first use of the encryption, with the module, or with none. With
// none, libsodium goes on with the bytes inside the file, as it always did, so Node needs nothing.
//
// Outside the built file (the library's tests, the command, the plugin) nothing calls `chooseWasm`: `startLibsodium` then only sets a flag.

import { AgentError } from "./errors";

/** What libsodium's start-up hands over: the options it was given, and the imports its WebAssembly needs. */
interface Options {
  instantiateWasm?: (imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => unknown;
}

let chosen: WebAssembly.Module | undefined;
let decided = false;
let go: () => void = () => undefined;
const started = new Promise<void>((resolve) => {
  go = resolve;
});

/** True for a WebAssembly.Module, also one made in another realm (a test's, a vm context's), where `instanceof` says no. */
const isModule = (value: unknown): value is WebAssembly.Module => Object.prototype.toString.call(value) === "[object WebAssembly.Module]";

/**
 * Lets libsodium start, with `module` as its WebAssembly when there is one. The first call decides: libsodium starts only once. A module
 * that is not a WebAssembly.Module is refused before anything starts.
 */
export function startLibsodium(module?: WebAssembly.Module): void {
  if (module !== undefined && !isModule(module)) {
    throw new AgentError("bad-settings", "The agent's wasm has to be a compiled WebAssembly.Module (in a Worker, the imported .wasm file).");
  }
  if (!decided) {
    decided = true;
    chosen = module;
  }
  go();
}

/**
 * Called by libsodium's start-up in the built file, just before it picks how to make its WebAssembly. Waits for `startLibsodium`. When
 * a module was given it is made into an instance here, so a fault is a fault of this call, and libsodium is handed that instance in
 * place of making one.
 */
export async function chooseWasm(options: Options, imports: WebAssembly.Imports): Promise<void> {
  await started;
  const module = chosen;
  if (module === undefined || options.instantiateWasm !== undefined) return;
  const instance = await WebAssembly.instantiate(module, imports);
  options.instantiateWasm = (_imports, receive) => {
    receive(instance, module);
    return {};
  };
}
