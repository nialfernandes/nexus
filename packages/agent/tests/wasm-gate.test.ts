// The gate that hands libsodium a WebAssembly module (src/wasm-gate.ts). libsodium waits at it; `startLibsodium` lets it go, with a module or
// without one. Each test loads the gate fresh, because what the first call decides is decided for the life of the module.

import { beforeEach, describe, expect, it, vi } from "vitest";

/** The smallest WebAssembly module there is: the magic number and the version, no code. It needs no imports. */
const EMPTY = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

type Gate = typeof import("../src/wasm-gate");
let gate: Gate;

beforeEach(async () => {
  vi.resetModules();
  gate = await import("../src/wasm-gate");
});

/** Whether a promise has settled, without waiting for it. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol("pending");
  return (await Promise.race([promise.then(() => true, () => true), Promise.resolve(marker)])) !== marker;
}

describe("the gate libsodium waits at", () => {
  it("holds libsodium until the vault says it may start", async () => {
    const options: Record<string, unknown> = {};
    const waiting = gate.chooseWasm(options, {});
    expect(await settled(waiting)).toBe(false);
    gate.startLibsodium();
    await waiting;
    expect(options, "no module was given, so libsodium makes its own from the bytes inside the file").toEqual({});
  });

  it("gives libsodium the instance of the module it was given, in place of one made from bytes", async () => {
    const module = new WebAssembly.Module(EMPTY);
    gate.startLibsodium(module);
    const options: { instantiateWasm?: (imports: object, receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => unknown } = {};
    await gate.chooseWasm(options, {});
    expect(typeof options.instantiateWasm).toBe("function");

    const received: Array<[WebAssembly.Instance, WebAssembly.Module]> = [];
    const returned = options.instantiateWasm!({}, (instance, compiled) => received.push([instance, compiled]));
    expect(returned, "an object, as libsodium's start-up expects of its own hook").toEqual({});
    expect(received).toHaveLength(1);
    expect(received[0]![0]).toBeInstanceOf(WebAssembly.Instance);
    expect(received[0]![1]).toBe(module);
  });

  it("leaves a start-up that already has a way of its own alone", async () => {
    gate.startLibsodium(new WebAssembly.Module(EMPTY));
    const own = () => ({});
    const options = { instantiateWasm: own };
    await gate.chooseWasm(options, {});
    expect(options.instantiateWasm).toBe(own);
  });

  it("lets libsodium go on without a module once the vault started with none, and a later module is too late", async () => {
    gate.startLibsodium();
    gate.startLibsodium(new WebAssembly.Module(EMPTY));
    const options: Record<string, unknown> = {};
    await gate.chooseWasm(options, {});
    expect(options).toEqual({});
  });

  it("refuses what is not a compiled module, and starts nothing for it", async () => {
    for (const wrong of [EMPTY, "module", {}, 7, null] as unknown[]) {
      expect(() => gate.startLibsodium(wrong as WebAssembly.Module), String(wrong)).toThrowError(expect.objectContaining({ name: "AgentError", code: "bad-settings" }));
    }
    const waiting = gate.chooseWasm({}, {});
    expect(await settled(waiting), "still waiting: the refusals let nothing go").toBe(false);
    gate.startLibsodium();
    await waiting;
  });

  it("takes a module made in another realm, where instanceof says no", async () => {
    const vm = await import("node:vm");
    const foreign = vm.runInNewContext("new WebAssembly.Module(bytes)", { bytes: EMPTY }) as WebAssembly.Module;
    expect(foreign instanceof WebAssembly.Module).toBe(false);
    expect(() => gate.startLibsodium(foreign)).not.toThrow();
    const options: Parameters<Gate["chooseWasm"]>[0] = {};
    await gate.chooseWasm(options, {});
    expect(typeof options.instantiateWasm).toBe("function");
  });
});
