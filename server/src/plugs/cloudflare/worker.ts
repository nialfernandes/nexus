// The Worker: what Cloudflare runs. It sends /nexus/api/* to Nexus, and
// gives the device approval page to whoever opens its link; every other address is not Nexus's and is a plain 404.
//
// Nexus answers an unknown caller 401 itself (a program that calls an API has to be told it is not allowed, and a
// redirect to a sign-in page would be mistaken for an answer), so there is no gate in front of it. The approval page
// and its files are the same for everyone and hold nothing private, so they are sent to a browser that is not signed in:
// the page is where the owner signs in for a first device, with the owner secret. Every call the page then makes to
// Nexus is checked as the owner's.

import { routeName } from "../../addresses";
import { runNexus } from "../../routes";
import { cloudflareHost, type NexusEnv } from "./host";
import { isNexusAsset, serveNexusAsset } from "./page";

const text = (status: number, words: string): Response =>
  new Response(words, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export default {
  async fetch(request: Request, env: NexusEnv): Promise<Response> {
    try {
      const { pathname } = new URL(request.url);
      if (routeName(pathname) !== null) return await runNexus(request, cloudflareHost(env));

      if (request.method === "GET" && isNexusAsset(pathname)) return await serveNexusAsset(request, env);
      return text(404, "Not found");
    } catch (error) {
      // A setting that cannot be used, most likely. Nothing of it goes to the caller; the log says what it was.
      console.error("nexus: the Worker could not start a request", error);
      return text(503, "Nexus could not answer just now.");
    }
  },
};
