import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { EngineRuntime } from "../src/core/engine.ts";
import { ensureWorkspace, saveToDir } from "../src/host/disk.ts";
import { parseWorkspace } from "../src/core/files.ts";
import { sampleWorkspace } from "../src/core/sample.ts";
import type { ExecutePayload, LoadPayload, RunPayload, Workspace } from "../src/core/types.ts";
import { createModuleLoader } from "../src/host/moduleLoader.ts";

declare const __dirname: string;

const here = __dirname;
const runtime = new EngineRuntime();
let currentDir = "";
let settingsPath = "";
let mainWindow: BrowserWindow | null = null;
let latestSave: { workspace: Workspace; dir: string } | null = null;
let saveChain: Promise<void> = Promise.resolve();

app.setName("Omnium");

app.whenReady().then(async () => {
  settingsPath = path.join(app.getPath("userData"), "settings.json");
  currentDir = (await rememberedDir()) ?? path.join(app.getPath("documents"), "Omnium");
  await ensureWorkspace(currentDir);
  await remember(currentDir);
  hardenSession();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 760,
    minHeight: 560,
    title: "Omnium",
    backgroundColor: "#101210",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 14, y: 16 },
    show: false,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = win;
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const guard = (event: Electron.Event, target: string) => {
    if (!allowNavigation(target)) event.preventDefault();
  };
  win.webContents.on("will-navigate", guard);
  win.webContents.on("will-redirect", guard);
  const dev = process.env.OMNIUM_DEV_SERVER;
  if (dev) void win.loadURL(dev);
  else void win.loadFile(path.join(here, "../dist/index.html"));
  buildMenu(win);
}

function buildMenu(win: BrowserWindow): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Omnium",
      submenu: [
        { role: "about", label: "Acerca de Omnium" },
        { type: "separator" },
        { role: "quit", label: "Salir" },
      ],
    },
    {
      label: "Archivo",
      submenu: [
        { label: "Nueva área de trabajo", accelerator: "CmdOrCtrl+N", click: () => win.webContents.send("menu", "new") },
        { label: "Abrir área…", accelerator: "CmdOrCtrl+O", click: () => win.webContents.send("menu", "open") },
        { type: "separator" },
        { role: "close", label: "Cerrar" },
      ],
    },
    { role: "editMenu" },
    {
      label: "Ver",
      submenu: [
        { role: "reload", label: "Recargar" },
        { role: "toggleDevTools", label: "Herramientas" },
        { type: "separator" },
        { role: "resetZoom", label: "Tamaño real" },
        { role: "zoomIn", label: "Acercar" },
        { role: "zoomOut", label: "Alejar" },
        { type: "separator" },
        { role: "togglefullscreen", label: "Pantalla completa" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle("workspace:load", async () => {
  const workspace = await ensureWorkspace(currentDir);
  return { dir: currentDir, workspace };
});

ipcMain.handle("workspace:save", async (_event, raw: unknown) => {
  const workspace = parseWorkspace(raw);
  const dir = currentDir;
  latestSave = { workspace, dir };
  saveChain = saveChain
    .catch(() => undefined)
    .then(async () => {
      while (latestSave) {
        const next = latestSave;
        latestSave = null;
        await saveToDir(next.dir, next.workspace);
      }
    });
  await saveChain;
});

ipcMain.handle("workspace:open", async () => {
  const pick = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  const dir = pick.filePaths[0];
  if (pick.canceled || !dir) return null;
  try {
    await readFile(path.join(dir, "omnium.json"), "utf8");
  } catch {
    const answer = await dialog.showMessageBox({
      type: "question",
      message: "Esta carpeta no tiene un área de Omnium.",
      detail: "Se creará una colección de ejemplo.",
      buttons: ["Cancelar", "Crear"],
    });
    if (answer.response !== 1) return null;
  }
  currentDir = dir;
  await remember(dir);
  runtime.clearCookies();
  await saveChain.catch(() => undefined);
  return { dir, workspace: await ensureWorkspace(dir) };
});

ipcMain.handle("workspace:create", async () => {
  const pick = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Crear aquí",
  });
  const dir = pick.filePaths[0];
  if (pick.canceled || !dir) return null;
  try {
    await readFile(path.join(dir, "omnium.json"), "utf8");
    const answer = await dialog.showMessageBox({
      type: "warning",
      message: "Esta carpeta ya tiene un área de Omnium.",
      buttons: ["Cancelar", "Reemplazar"],
    });
    if (answer.response !== 1) return null;
  } catch {
    /* carpeta nueva */
  }
  const workspace = sampleWorkspace();
  await saveToDir(dir, workspace);
  currentDir = dir;
  await remember(dir);
  runtime.clearCookies();
  await saveChain.catch(() => undefined);
  return { dir, workspace };
});

ipcMain.handle("workspace:reveal", async () => {
  shell.showItemInFolder(path.join(currentDir, "omnium.json"));
});

ipcMain.handle("workspace:export", async (_event, raw: unknown) => {
  const workspace = parseWorkspace(raw);
  const pick = await dialog.showSaveDialog({
    defaultPath: `${workspace.name || "omnium"}.omnium.json`,
    filters: [{ name: "Omnium", extensions: ["json"] }],
  });
  if (pick.canceled || !pick.filePath) return false;
  await writeFile(pick.filePath, `${JSON.stringify(workspace, null, 2)}\n`, "utf8");
  return true;
});

/** El IPC clona sin funciones: el host adjunta `omnium.require` con el
 * directorio del payload o con el del área abierta. */
function withModules<T extends ExecutePayload | RunPayload>(payload: T): T {
  if (!payload || payload.requireModule) return payload;
  return { ...payload, requireModule: createModuleLoader(payload.moduleDir ?? currentDir) };
}

ipcMain.handle("http:execute", async (_event, payload: ExecutePayload) => runtime.execute(withModules(payload)));

ipcMain.handle("http:run", async (_event, payload: RunPayload) => runtime.run(withModules(payload)));

ipcMain.handle("http:cancel", async () => {
  runtime.cancelHttp();
});

ipcMain.handle("load:start", async (event, payload: LoadPayload) => {
  const send = (channel: "load:tick" | "load:done", snapshot: unknown) => {
    if (!event.sender.isDestroyed()) event.sender.send(channel, snapshot);
  };
  const snap = await runtime.startLoad(payload, {
    onTick: (tick) => send("load:tick", tick),
  });
  send("load:done", snap);
  return snap;
});

ipcMain.handle("load:stop", async () => {
  runtime.stopLoad();
});

ipcMain.handle("cookies:list", async () => runtime.listCookies());

ipcMain.handle("cookies:clear", async () => {
  runtime.clearCookies();
});

ipcMain.handle("app:setTitle", async (_event, title: string) => {
  mainWindow?.setTitle(title);
});

function allowNavigation(target: string): boolean {
  const dev = process.env.OMNIUM_DEV_SERVER;
  if (dev) return target.startsWith(dev);
  return target.startsWith("file://");
}

function hardenSession(): void {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    void webContents;
    void permission;
    callback(false);
  });
  if (process.env.OMNIUM_DEV_SERVER) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:",
        ],
      },
    });
  });
}

async function rememberedDir(): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(settingsPath, "utf8")) as { workspaceDir?: string };
    return raw.workspaceDir ?? null;
  } catch {
    return null;
  }
}

async function remember(dir: string): Promise<void> {
  await writeFile(settingsPath, `${JSON.stringify({ workspaceDir: dir }, null, 2)}\n`, "utf8");
}
