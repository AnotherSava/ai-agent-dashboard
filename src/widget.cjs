const { app, BrowserWindow, screen, Tray, Menu, nativeImage, ipcMain, shell } = require("electron");
const path = require("path");
const http = require("http");
const fs = require("fs");
const logWatcher = require("./log-watcher.cjs");

const ROOT = path.join(__dirname, "..");
const WIDGET_LOG_PATH = path.join(ROOT, "widget.log");
const CONFIG_PATH = path.join(ROOT, "config", "config.json");
function logEvent(event, data = {}) {
  try {
    fs.appendFileSync(WIDGET_LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n");
  } catch {}
}

function loadConfig() {
  const defaults = { show_source_icon: true };
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const loaded = JSON.parse(raw);
    return loaded && typeof loaded === "object" ? { ...defaults, ...loaded } : defaults;
  } catch {
    return defaults;
  }
}

ipcMain.on("get-config", (event) => { event.returnValue = loadConfig(); });

let win;
let tray;
let position = "bottom-right";

// In-memory state
const chats = new Map();
const sseClients = new Set();

function broadcast() {
  const data = JSON.stringify(Array.from(chats.values()));
  for (const res of sseClients) {
    res.write(`data: ${data}\n\n`);
  }
}

const VALID_STATUSES = new Set(["idle", "working", "thinking", "done", "error"]);

function onWatcherStateChange(chatId, newStatus) {
  const existing = chats.get(chatId);
  if (!existing) return;
  if (existing.status === newStatus) return;
  chats.set(chatId, { ...existing, status: newStatus, updated: Date.now() });
  broadcast();
}

function onWatcherError(info) {
  logEvent("watcher_error", info);
  // Claude Code creates the transcript JSONL lazily — a SessionStart hook can
  // fire seconds before the file exists. The next hook event retries cleanly.
  // Still logged above, just don't surface as an error row.
  if (info.phase === "initial-stat" && info.code === "ENOENT") return;
  chats.set("watcher-error", {
    id: "watcher-error",
    status: "error",
    label: `${info.phase}: ${info.error}`.slice(0, 60),
    source: "watcher",
    updated: Date.now(),
  });
  broadcast();
}

function safeOpenUrl(url) {
  if (typeof url !== "string") return;
  try {
    const u = new URL(url);
    if (u.protocol === "https:" || u.protocol === "http:") shell.openExternal(url);
  } catch {}
}

// HTTP server on port 9077 — receives POSTs from MCP, serves SSE to widget renderer
const httpServer = http.createServer((req, res) => {
  // SSE endpoint for the renderer
  if (req.url === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(`data: ${JSON.stringify(Array.from(chats.values()))}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // POST from MCP server / integrations / renderer
  if (req.url === "/api/status" && req.method === "POST") {
    // CSRF guard: reject browser requests from http/https origins.
    // No Origin header = non-browser client (curl, Node, Python). Renderer loads via file:// → Origin: null.
    const origin = req.headers.origin;
    if (origin && origin !== "null") {
      res.writeHead(403);
      res.end("forbidden origin");
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const msg = JSON.parse(body);
        if (msg.action === "set") {
          if (typeof msg.id !== "string" || !VALID_STATUSES.has(msg.status)) {
            res.writeHead(400);
            res.end("bad input");
            return;
          }
          const existing = chats.get(msg.id);
          const label = typeof msg.label === "string" ? msg.label : (existing ? existing.label : "");
          const source = typeof msg.source === "string" ? msg.source : (existing ? existing.source : "unknown");
          const updated = typeof msg.updated === "number" ? msg.updated : Date.now();
          const transcript_path = typeof msg.transcript_path === "string" ? msg.transcript_path : (existing ? existing.transcript_path : undefined);
          chats.set(msg.id, { id: msg.id, status: msg.status, label, source, updated, transcript_path });
          if (transcript_path) logWatcher.startWatching(msg.id, transcript_path, onWatcherStateChange, onWatcherError);
          broadcast();
        } else if (msg.action === "clear") {
          if (typeof msg.id === "string") {
            const existing = chats.get(msg.id);
            if (existing && existing.transcript_path) logWatcher.stopWatching(existing.transcript_path);
            chats.delete(msg.id);
          }
          broadcast();
        } else if (msg.action === "config") {
          if (msg.key === "alwaysOnTop" && win) {
            win.setAlwaysOnTop(!!msg.value, msg.value ? "floating" : undefined);
          } else if (msg.key === "position") {
            reposition(msg.value);
          } else if (msg.key === "openUrl") {
            safeOpenUrl(msg.value);
          }
        }
        res.writeHead(200);
        res.end("ok");
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

httpServer.listen(9077, "127.0.0.1");

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = display.workAreaSize;
  const winW = 260;
  const winH = 180;
  const margin = 12;
  const pos = getPosition(sw, sh, winW, winH, margin);

  win = new BrowserWindow({
    width: winW,
    height: winH,
    minWidth: 200,
    minHeight: 100,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    icon: path.join(ROOT, "assets", "ai-agent-dashboard.ico"),
    resizable: true,
    minimizable: false,
    maximizable: false,
    focusable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  win.loadFile(path.join(__dirname, "widget.html"));
  win.setAlwaysOnTop(true, "floating");
  win.on("closed", () => { win = null; });
}

function getPosition(sw, sh, winW, winH, margin) {
  switch (position) {
    case "top-right": return { x: sw - winW - margin, y: margin };
    case "top-left": return { x: margin, y: margin };
    case "bottom-left": return { x: margin, y: sh - winH - margin };
    case "bottom-right":
    default: return { x: sw - winW - margin, y: sh - winH - margin };
  }
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(ROOT, "assets", "ai-agent-dashboard.ico"));
  tray = new Tray(icon);
  tray.setToolTip("AI Agent Dashboard");

  tray.on("click", () => {
    if (win) {
      win.isVisible() ? win.hide() : (win.show(), win.focus());
    } else {
      createWindow();
    }
  });

  const contextMenu = Menu.buildFromTemplate([
    { label: "Show / Hide", click: () => tray.emit("click") },
    { type: "separator" },
    {
      label: "Position",
      submenu: [
        { label: "Top Right", type: "radio", checked: position === "top-right", click: () => reposition("top-right") },
        { label: "Top Left", type: "radio", checked: position === "top-left", click: () => reposition("top-left") },
        { label: "Bottom Right", type: "radio", checked: position === "bottom-right", click: () => reposition("bottom-right") },
        { label: "Bottom Left", type: "radio", checked: position === "bottom-left", click: () => reposition("bottom-left") },
      ],
    },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
  tray.setContextMenu(contextMenu);
}

function reposition(pos) {
  position = pos;
  if (win) {
    const display = screen.getPrimaryDisplay();
    const { width: sw, height: sh } = display.workAreaSize;
    const bounds = win.getBounds();
    const p = getPosition(sw, sh, bounds.width, bounds.height, 12);
    win.setPosition(p.x, p.y);
  }
}

ipcMain.on("minimize", () => { if (win) win.hide(); });
ipcMain.on("close", () => { app.quit(); });

app.whenReady().then(() => {
  createTray();
  createWindow();
});

app.on("window-all-closed", (e) => { e.preventDefault(); });
app.on("before-quit", () => logWatcher.stopAll());
