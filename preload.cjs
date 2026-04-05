const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("widget", {
  minimize: () => ipcRenderer.send("minimize"),
  close: () => ipcRenderer.send("close"),
});
