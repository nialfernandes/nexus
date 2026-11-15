// The calls an agent makes to Nexus, over a `fetch` it is given (or the one the runtime has). Nothing here is Node's: a Worker
// has the same `fetch`. The token is sent as a bearer token and is never put in a message.

import { AgentError } from "./errors";

/** The part of `fetch` this library uses, so a test or a runtime can hand in its own. The global `fetch` fits it. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface Reply {
  status: number;
  /** The parsed JSON, or an empty object when the answer was not JSON. */
  json: any;
}

/** The address Nexus's routes sit under, with no slash at the end: such as https://nexus.example.org/nexus/api. */
export function cleanAddress(address: unknown): string {
  let url: URL;
  try {
    url = new URL(typeof address === "string" ? address.trim() : "");
  } catch {
    throw new AgentError("bad-settings", "The Nexus address is missing or is not a web address. It is the address the server's routes sit under, such as https://nexus.example.org/nexus/api.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AgentError("bad-settings", "The Nexus address has to be an http or https address.");
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

export class Nexus {
  readonly #address: string;
  readonly #token: string | null;
  readonly #fetch: FetchLike;

  /** `token` is null for the two calls a device makes before it has one (a sign-in's start and poll). */
  constructor(address: string, token: string | null, fetcher?: FetchLike) {
    this.#address = cleanAddress(address);
    this.#token = token === null ? null : token.trim();
    // The runtime's own `fetch` is called as a function of the global scope, which a Worker needs.
    this.#fetch = fetcher ?? ((url, init) => globalThis.fetch(url, init));
  }

  get(route: string, params: Record<string, string | number | undefined> = {}): Promise<Reply> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value));
    const text = query.toString();
    return this.#send("GET", `${route}${text ? `?${text}` : ""}`);
  }

  post(route: string, body: unknown): Promise<Reply> {
    return this.#send("POST", route, JSON.stringify(body));
  }

  async #send(method: string, route: string, body?: string): Promise<Reply> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.#token !== null) headers.authorization = `Bearer ${this.#token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let answer: { status: number; text(): Promise<string> };
    try {
      answer = await this.#fetch(`${this.#address}/${route}`, { method, headers, ...(body === undefined ? {} : { body }) });
    } catch {
      throw new AgentError("unreachable", "Nexus could not be reached. Check the address and that you are online.");
    }
    let text = "";
    try {
      text = await answer.text();
    } catch {
      throw new AgentError("unreachable", "Nexus could not be reached: the answer was cut off.");
    }
    let json: unknown = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON: a page, or nothing */
    }
    return { status: answer.status, json: typeof json === "object" && json !== null ? json : {} };
  }
}

/** Turns an answer that is not the one wanted into a plain refusal, in Nexus's own words when it gave some. */
export function refusal(reply: Reply, what: string): AgentError {
  if (reply.status === 401) return new AgentError("refused", "Nexus did not accept the agent's sign-in token. It may have been revoked: sign in again.");
  const said = typeof reply.json.error === "string" ? ` ${reply.json.error}` : "";
  return new AgentError("refused", `Nexus would not ${what} (it answered ${reply.status}).${said}`);
}
