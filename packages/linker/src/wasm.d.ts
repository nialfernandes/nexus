// A Worker imports a `.wasm` file as a compiled WebAssembly module. @nexus/agent builds the one libsodium needs beside its library.
declare module "@nexus/agent/nexus-agent.wasm" {
  const compiled: WebAssembly.Module;
  export default compiled;
}
