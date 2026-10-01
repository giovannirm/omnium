import { useEffect, useRef, useState } from "react";
import type { Client } from "../../client.ts";
import type { CookieView } from "../../core/cookies.ts";
import type { Workspace } from "../../core/types.ts";
import {
  appendCollection,
  appendEnvironment,
  appendRequest,
  closeTabAt,
  defaultSelection,
  duplicateRequest,
  moveRequestIn,
  openTab,
  pruneSelection,
  pruneTabs,
  removeCollection,
  removeEnvironment,
  removeRequestIn,
  toTab,
  updateEnvironmentIn,
  updateRequestIn,
  type Selection,
  type Tab,
} from "./model.ts";

export type Modal = null | "help" | "curl" | "palette" | "snippet" | "cookies";

export type AppState = ReturnType<typeof useAppState>;

/**
 * Capa de estado de la aplicación. Toda la orquestación vive acá: la UI solo
 * compone y renderiza. Se carga por dominios: primero workspace/persistencia y
 * selección; después ejecución/carga; al final el chrome de la interfaz.
 */
export function useAppState(options: { client: Client }) {
  const { client } = options;

  // --- workspace y persistencia ---
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [dir, setDir] = useState<string | null>(null);
  const [saveLabel, setSaveLabel] = useState("Listo");

  // --- selección y pestañas ---
  const [selection, setSelection] = useState<Selection | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);

  // --- avisos ---
  const [toast, setToast] = useState<string | null>(null);

  // --- cookies de sesión ---
  const [cookieRows, setCookieRows] = useState<CookieView[]>([]);

  const hydrated = useRef(false);
  const workspaceRef = useRef<Workspace | null>(null);
  workspaceRef.current = workspace;

  function notify(message: string, ms = 3200): void {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? null : current)), ms);
  }

  useEffect(() => {
    let live = true;
    void client.load().then((loaded) => {
      if (!live) return;
      setWorkspace(loaded.workspace);
      setDir(loaded.dir);
      const picked = defaultSelection(loaded.workspace);
      if (picked) {
        setSelection(picked);
        const tab = toTab(picked);
        if (tab) setTabs([tab]);
      }
      if (loaded.warning) notify(loaded.warning, 5200);
      void refreshCookies();
    });
    return () => {
      live = false;
    };
  }, [client]);

  async function refreshCookies(): Promise<void> {
    try {
      setCookieRows(await client.listCookies());
    } catch {
      return;
    }
  }

  async function forgetCookies(): Promise<void> {
    if (!window.confirm("¿Olvidar las cookies de esta sesión?")) return;
    await client.clearCookies();
    setCookieRows([]);
    notify("Cookies olvidadas");
  }

  useEffect(() => {
    if (!workspace) return;
    void client.setTitle(`Omnium — ${workspace.name}`);
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    setSaveLabel("Guardando…");
    const timer = setTimeout(() => {
      void client
        .save(workspace)
        .then(() => setSaveLabel("Guardado"))
        .catch(() => {
          setSaveLabel("No se pudo guardar");
          notify("No se pudo guardar el área de trabajo");
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [workspace, client]);

  useEffect(() => {
    const flush = () => {
      const current = workspaceRef.current;
      if (current) void client.save(current);
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [client]);

  useEffect(() => {
    if (!workspace) return;
    setTabs((current) => pruneTabs(current, workspace));
    setSelection((current) => pruneSelection(current, workspace));
  }, [workspace]);

  function saveNow(): void {
    const current = workspaceRef.current;
    if (!current) return;
    setSaveLabel("Guardando…");
    void client
      .save(current)
      .then(() => setSaveLabel("Guardado"))
      .catch(() => {
        setSaveLabel("No se pudo guardar");
        notify("No se pudo guardar el área de trabajo");
      });
  }

  /** Cambia el área activa y reinicia la selección; el resto del estado de sesión lo limpia App. */
  function adoptWorkspace(next: Workspace, nextDir: string | null, persist = false): void {
    if (!persist) hydrated.current = false;
    setWorkspace(next);
    setDir(nextDir);
    const picked = defaultSelection(next);
    setSelection(picked);
    const tab = toTab(picked);
    setTabs(tab ? [tab] : []);
  }

  async function openArea(): Promise<{ dir: string; workspace: Workspace } | null> {
    return client.open();
  }

  async function createArea(): Promise<{ dir: string; workspace: Workspace } | null> {
    return client.create();
  }

  async function exportArea(): Promise<void> {
    if (!workspace) return;
    const done = await client.exportFile(workspace);
    if (done) notify("Área exportada");
  }

  // --- selección y pestañas ---

  function choose(next: Selection): void {
    setSelection(next);
    if (next.kind === "request") setTabs((current) => openTab(current, next));
  }

  function closeTab(requestId: string): void {
    const closed = closeTabAt(tabs, selection, requestId);
    setTabs(closed.tabs);
    if (closed.selection !== undefined) setSelection(closed.selection);
  }

  // --- colecciones, peticiones y ambientes ---

  function createCollection(): void {
    if (!workspace) return;
    const next = appendCollection(workspace);
    setWorkspace(next.workspace);
    choose(next.selection);
  }

  function createRequestIn(collectionId: string): void {
    if (!workspace) return;
    const next = appendRequest(workspace, collectionId);
    setWorkspace(next.workspace);
    choose(next.selection);
  }

  function deleteCollection(collectionId: string): void {
    if (!workspace) return;
    if (!window.confirm("¿Eliminar esta colección?")) return;
    setWorkspace(removeCollection(workspace, collectionId));
  }

  function deleteRequest(collectionId: string, requestId: string): void {
    if (!window.confirm("¿Eliminar esta petición?")) return;
    setWorkspace((current) => (current ? removeRequestIn(current, collectionId, requestId) : current));
    closeTab(requestId);
  }

  function duplicateRequestIn(collectionId: string, requestId: string): void {
    if (!workspace) return;
    const next = duplicateRequest(workspace, collectionId, requestId);
    if (!next) return;
    setWorkspace(next.workspace);
    choose(next.selection);
  }

  function moveRequest(collectionId: string, requestId: string, delta: number): void {
    setWorkspace((current) => (current ? moveRequestIn(current, collectionId, requestId, delta) : current));
  }

  function updateRequest(collectionId: string, request: Parameters<typeof updateRequestIn>[2]): void {
    setWorkspace((current) => (current ? updateRequestIn(current, collectionId, request) : current));
  }

  function createEnvironment(): void {
    if (!workspace) return;
    const next = appendEnvironment(workspace);
    setWorkspace(next.workspace);
    setSelection(next.selection);
  }

  function deleteEnvironment(environmentId: string): void {
    if (!workspace) return;
    const next = removeEnvironment(workspace, environmentId);
    if (!next) {
      notify("Deja al menos un ambiente");
      return;
    }
    setWorkspace(next);
    setSelection(null);
  }

  function updateEnvironment(environment: Parameters<typeof updateEnvironmentIn>[1]): void {
    if (!workspace) return;
    setWorkspace(updateEnvironmentIn(workspace, environment));
  }

  return {
    // workspace
    workspace,
    setWorkspace,
    dir,
    saveLabel,
    saveNow,
    adoptWorkspace,
    openArea,
    createArea,
    exportArea,
    // selección
    selection,
    setSelection,
    tabs,
    choose,
    closeTab,
    // entidades
    createCollection,
    createRequestIn,
    deleteCollection,
    deleteRequest,
    duplicateRequestIn,
    moveRequest,
    updateRequest,
    createEnvironment,
    deleteEnvironment,
    updateEnvironment,
    // avisos
    toast,
    notify,
    // cookies
    cookieRows,
    refreshCookies,
    forgetCookies,
  };
}
