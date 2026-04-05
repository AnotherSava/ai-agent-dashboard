import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import http from "http";
import { z } from "zod";

// Lock chat_id per MCP server instance (one per Claude Code session)
let lockedChatId = null;

// POST status updates to the widget's HTTP endpoint
function postStatus(data) {
  const body = JSON.stringify(data);
  const req = http.request(
    {
      hostname: "127.0.0.1",
      port: 7890,
      path: "/api/status",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: 2000,
    },
    () => {}
  );
  req.on("error", () => {}); // widget might not be running — that's fine
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
    status: z.enum(["idle", "working", "thinking", "done", "error"]).describe("Current status"),
    label: z.string().optional().describe("Short description of what you're doing"),
  },
  async ({ chat_id, status, label }) => {
    // First call locks the chat_id for this session; subsequent calls reuse it
    if (!lockedChatId) {
      lockedChatId = chat_id;
    }
    const id = lockedChatId;
    postStatus({ action: "set", id, status, label: label || "", updated: Date.now() });
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
    postStatus({ action: "clear", id });
    return { content: [{ type: "text", text: `Cleared: ${id}` }] };
  }
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
