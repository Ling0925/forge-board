import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { name, version } from "../../package.json";

export async function startProxy(url: string, token: string) {
  const upstream = new Client({ name, version });
  await upstream.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  const server = new Server({ name, version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, (request) =>
    upstream.listTools(request.params),
  );
  server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    upstream.callTool(request.params, undefined, { signal: extra.signal }),
  );
  await server.connect(new StdioServerTransport());
  process.stdin.once("end", () => {
    void server.close();
    void upstream.close();
  });
}
