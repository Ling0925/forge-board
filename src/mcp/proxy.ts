import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type RequestId,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
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
  const transport = new StdioServerTransport();
  const pending = new Set<RequestId>();
  let inputEnded = false;
  const drained = new Promise<void>((resolve) => {
    const finish = () => {
      if (inputEnded && pending.size === 0) resolve();
    };
    transport.onmessage = (message) => {
      if (isJSONRPCRequest(message)) pending.add(message.id);
    };
    const send = transport.send.bind(transport);
    transport.send = async (message) => {
      await send(message);
      if (
        (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) &&
        message.id !== undefined
      ) {
        pending.delete(message.id);
        finish();
      }
    };
    process.stdin.once("end", () => {
      inputEnded = true;
      finish();
    });
  });
  await server.connect(transport);
  await drained;
  await server.close();
  await upstream.close();
}
