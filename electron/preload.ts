import { contextBridge, ipcRenderer } from "electron";
import type { Client } from "../src/client.ts";
import type { ExecutePayload, LoadPayload, LoadSnapshot, RunPayload, Workspace } from "../src/core/types.ts";

function listen<T>(channel: string, callback: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: Client = {
  desktop: true,
  platform: process.platform,
  load: () => ipcRenderer.invoke("workspace:load"),
  save: (workspace: Workspace) => ipcRenderer.invoke("workspace:save", workspace),
  open: () => ipcRenderer.invoke("workspace:open"),
  create: () => ipcRenderer.invoke("workspace:create"),
  reveal: () => ipcRenderer.invoke("workspace:reveal"),
  exportFile: (workspace: Workspace) => ipcRenderer.invoke("workspace:export", workspace),
  execute: (payload: ExecutePayload) => ipcRenderer.invoke("http:execute", payload),
  run: (payload: RunPayload) => ipcRenderer.invoke("http:run", payload),
  cancelHttp: () => ipcRenderer.invoke("http:cancel"),
  startLoad: (payload: LoadPayload) => ipcRenderer.invoke("load:start", payload),
  stopLoad: () => ipcRenderer.invoke("load:stop"),
  listCookies: () => ipcRenderer.invoke("cookies:list"),
  clearCookies: () => ipcRenderer.invoke("cookies:clear"),
  setTitle: (title: string) => ipcRenderer.invoke("app:setTitle", title),
  onLoadTick: (callback: (snapshot: LoadSnapshot) => void) => listen("load:tick", callback),
  onLoadDone: (callback: (snapshot: LoadSnapshot) => void) => listen("load:done", callback),
  onMenu: (callback: (action: "new" | "open") => void) => listen("menu", callback),
};

contextBridge.exposeInMainWorld("omnium", api);
