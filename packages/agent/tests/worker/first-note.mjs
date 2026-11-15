// A Cloudflare Worker that uses the built library the way an agent does: it imports the built file and, beside it, the .wasm file the
// build wrote, which a Worker takes as a compiled module. It runs in workerd (tests/worker.test.ts), not in Node. The agent's address,
// sign-in token, private key and approval are the Worker's bindings, as strings, as a Worker's secrets are.

import { AgentVault } from "./nexus-agent.js";
import wasm from "./nexus-agent.wasm";

const PATH = "Agent/2026-11-15 First.md";

export default {
  async fetch(request, env) {
    const options = { address: env.ADDRESS, token: env.TOKEN, privateKey: env.PRIVATE_KEY, approval: env.APPROVAL };
    const route = new URL(request.url).pathname;

    // The same call without the module: the library then starts libsodium from bytes, which a Worker refuses.
    if (route === "/without-the-module") {
      try {
        await AgentVault.connect(options);
        return Response.json({ opened: true });
      } catch (error) {
        return Response.json({ opened: false, name: String(error?.name), message: String(error?.message ?? error) });
      }
    }

    // A writer that keeps its own note ids: it never opens the vault.
    const vault = await AgentVault.connect({ ...options, wasm });
    const created = await vault.createNote(PATH, "# First\n");
    const updated = await vault.updateNote(created.id, created.version, "# First\n\nSecond line.\n");
    const stale = await vault.updateNote(created.id, created.version, "# Stale\n");
    const read = await vault.readNote(created.id);
    vault.close();

    // And a writer that does open it, and goes by path.
    const opened = await AgentVault.open({ ...options, wasm });
    const listed = await opened.listNotes();
    const text = await opened.read(PATH);
    const written = await opened.write("Agent/2026-11-15 Second.md", "# Second\n");
    opened.close();

    return Response.json({ created, updated, stale, read, listed, text, written });
  },
};
