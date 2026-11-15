// A stand-in for a language model's chat endpoint, on a port of this machine: it answers the common chat-completions form, and keeps
// every request it was sent so a test can say what was asked, with which key, and how many times.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface Asked {
  path: string;
  authorization: string | undefined;
  body: { model: string; temperature: number; messages: Array<{ role: string; content: string }> };
}

/** What the server does with one call: answers with this text as the model's answer, or fails the way a model server can. */
export type Reply = string | { status: number; body?: string } | { delayMs: number } | { raw: string };

export interface ModelServer {
  /** The address to give the job as the model's address. */
  address: string;
  asked: Asked[];
  /** Decides each reply from the transcript the job sent, and the order of the call. */
  answer: (handler: (transcript: string, call: number) => Reply | Promise<Reply>) => void;
  close: () => Promise<void>;
}

const completion = (content: string): string => JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });

export async function startModelServer(): Promise<ModelServer> {
  const asked: Asked[] = [];
  let handler: Parameters<ModelServer["answer"]>[0] = () => "[]";
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      asked.push({ path: request.url ?? "", authorization: request.headers.authorization, body });
      const transcript = body.messages.find((message: { role: string }) => message.role === "user").content as string;
      const reply = await handler(transcript, asked.length);
      if (typeof reply === "object" && "delayMs" in reply) {
        // A model that takes too long: the job gives up, and the connection is dropped.
        await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
        response.destroy();
        return;
      }
      if (typeof reply === "object" && "raw" in reply) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(reply.raw);
        return;
      }
      if (typeof reply === "object") {
        response.writeHead(reply.status, { "content-type": "application/json" });
        response.end(reply.body ?? JSON.stringify({ error: { message: "stand-in failure" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(completion(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    address: `http://127.0.0.1:${port}/v1`,
    asked,
    answer: (next) => {
      handler = next;
    },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
