import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(__dirname, "..", "mcp.log");

// JSON-lines logger. Writes to <repo>/mcp.log. Never throws.
// Don't write to stdout -- MCP reserves stdout for protocol frames.
function log(event, data = {}) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, event, ...data }) + "\n";
    fs.appendFileSync(LOG_PATH, line);
  } catch {
    /* swallow -- logging must not crash the MCP server */
  }
}

// Lock chat_id per MCP server instance (one per Claude Code session)
let lockedChatId = null;

log("startup", { cwd: process.cwd(), ppid: process.ppid });

// POST status updates to the widget's HTTP endpoint
function postStatus(data) {
  const body = JSON.stringify(data);
  const started = Date.now();
  const req = http.request(
    {
      hostname: "127.0.0.1",
      port: 9077,
      path: "/api/status",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: 2000,
    },
    (res) => log("widget_response", { action: data.action, status: res.statusCode, ms: Date.now() - started })
  );
  req.on("error", (err) => log("widget_error", { action: data.action, error: err.message, ms: Date.now() - started }));
  req.on("timeout", () => { log("widget_timeout", { action: data.action, ms: Date.now() - started }); req.destroy(); });
  req.write(body);
  req.end();
}

const mcp = new McpServer({
  name: "claude-status",
  version: "1.0.0",
});

mcp.tool(
  "set_status",
  "Update the status of the current chat on the live dashboard widget. Call this at the START of every response with status 'working' and at the END with 'done'. Use 'thinking' when planning/researching, 'error' if something fails.",
  {
    chat_id: z.string().describe("Unique chat identifier — use the conversation topic or a short label"),
    status: z.enum(["idle", "working", "thinking", "awaiting", "done", "error"]).describe("Current status"),
    label: z.string().optional().describe("Short description of what you're doing"),
  },
  async ({ chat_id, status, label }) => {
    const firstCall = !lockedChatId;
    if (!lockedChatId) lockedChatId = chat_id;
    const id = lockedChatId;
    log("set_status", { requested_chat_id: chat_id, id, status, label: label || "", first_call: firstCall });
    postStatus({ action: "set", id, status, label: label || "", source: "claude", updated: Date.now() });
    return { content: [{ type: "text", text: `Status set: ${id} → ${status}` }] };
  }
);

mcp.tool(
  "clear_status",
  "Remove a chat from the dashboard widget",
  {
    chat_id: z.string().describe("Chat identifier to remove"),
  },
  async ({ chat_id }) => {
    const id = lockedChatId || chat_id;
    log("clear_status", { requested_chat_id: chat_id, id });
    postStatus({ action: "clear", id });
    return { content: [{ type: "text", text: `Cleared: ${id}` }] };
  }
);

process.on("exit", () => log("shutdown", { locked_chat_id: lockedChatId }));

const transport = new StdioServerTransport();
await mcp.connect(transport);
