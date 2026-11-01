import { once } from "node:events";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { expect } from "vitest";
import { name, version } from "../package.json";
import type { Event } from "../src/domain/index.js";
import { createApp } from "../src/http/index.js";
import type { createBoard } from "../src/service/index.js";

export async function serveBoard(board: ReturnType<typeof createBoard>) {
  const server = serve({
    fetch: createApp(board).fetch,
    hostname: "127.0.0.1",
    port: 0,
  }) as Server;
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected TCP server");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await closed;
    },
  };
}

export async function connectMcp(url: string, token: string) {
  const client = new Client({ name, version });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  expect(transport.sessionId).toBeUndefined();
  return client;
}

export function toolData(result: Pick<CallToolResult, "content" | "isError">) {
  const content = result.content[0]!;
  expect(content.type).toBe("text");
  if (content.type !== "text") throw new Error("Expected text tool result");
  return JSON.parse(content.text);
}

export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return toolData(result as CallToolResult);
}

export async function subscribe(
  url: string,
  secret: string,
  headers: Record<string, string> = {},
) {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${secret}`,
      Accept: "text/event-stream",
      ...headers,
    },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toContain("text/event-stream");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  async function next(): Promise<Event> {
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (!data) continue;
        const event: Event = JSON.parse(data.slice(6));
        expect(frame.split("\n")).toContain(`id: ${event.seq}`);
        return event;
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error("SSE ended before the next event");
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }
  return {
    next,
    close: () => {
      controller.abort();
    },
  };
}
