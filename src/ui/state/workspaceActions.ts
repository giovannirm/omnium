import { useRef, type Dispatch, type SetStateAction } from "react";
import type { Client } from "../../client.ts";
import { parseWorkspace } from "../../core/files.ts";
import { importPostman } from "../../core/postman.ts";
import { hasSecrets, maskWorkspace } from "../../core/secrets.ts";
import type { ExecutionResult, Workspace } from "../../core/types.ts";
import type { SessionReport } from "./executionActions.ts";
import {
  appendCollection,
  appendCollectionRaw,
  appendEnvironment,
  appendRequest,
  closeTabAt,
  defaultSelection,
  duplicateRequest,
  moveRequestIn,
  openTab,
  removeCollection,
  removeEnvironment,
  removeRequestIn,
  toTab,
  updateEnvironmentIn,
  updateRequestIn,
  type Selection,
  type Tab,
} from "./model.ts";

export type WorkspaceActions = ReturnType<typeof createWorkspaceActions>;

/** Dominio workspace: persistencia del área, selección/pestañas y entidades
 * (colecciones, peticiones, ambientes). Se crea dentro de `useAppState`, así
 * que las closures capturan el mismo render que el hook. */
export function createWorkspaceActions(deps: {
  client: Client;
  workspace: Workspace | null;
  dir: string | null;
  selection: Selection | null;
  tabs: Tab[];
  setWorkspace: Dispatch<SetStateAction<Workspace | null>>;
  setSelection: Dispatch<SetStateAction<Selection | null>>;
  setTabs: Dispatch<SetStateAction<Tab[]>>;
  setDir: Dispatch<SetStateAction<string | null>>;
  setSaveLabel: Dispatch<SetStateAction<string>>;
  setResults: Dispatch<SetStateAction<Record<string, ExecutionResult>>>;
  setReport: Dispatch<SetStateAction<SessionReport | null>>;
  setRuntime: Dispatch<SetStateAction<Record<string, string>>>;
  notify: (message: string, ms?: number) => void;
}) {
  const { client, workspace, dir, notify } = deps;
  const hydrated = useRef(false);
  const workspaceRef = useRef<Workspace | null>(null);
  workspaceRef.current = workspace;
  const importRef = useRef<HTMLInputElement>(null);
  const importKind = useRef<"area" | "postman">("area");

  function saveNow(): void {
    const current = workspaceRef.current;
    if (!current) return;
    deps.setSaveLabel("Guardando…");
    void client
      .save(current)
      .then(() => deps.setSaveLabel("Guardado"))
      .catch(() => {
        deps.setSaveLabel("No se pudo guardar");
        notify("No se pudo guardar el área de trabajo");
      });
  }

  /** Cambia el área activa: workspace, selección y toda la sesión de ejecución. */
  function adopt(next: Workspace, nextDir: string | null, persist = false): void {
    if (!persist) hydrated.current = false;
    deps.setWorkspace(next);
    deps.setDir(nextDir);
    deps.setResults({});
    deps.setReport(null);
    deps.setRuntime({});
    const picked = defaultSelection(next);
    deps.setSelection(picked);
    const tab = toTab(picked);
    deps.setTabs(tab ? [tab] : []);
  }

  async function openArea(): Promise<void> {
    const opened = await client.open();
    if (opened) adopt(opened.workspace, opened.dir);
  }

  async function createArea(): Promise<void> {
    const created = await client.create();
    if (created) adopt(created.workspace, created.dir);
  }

  async function exportArea(): Promise<void> {
    if (!workspace) return;
    const secrets = hasSecrets(workspace);
    const done = await client.exportFile(maskWorkspace(workspace));
    if (done) notify(secrets ? "Área exportada · secretos enmascarados" : "Área exportada");
  }

  // --- selección y pestañas ---

  function choose(next: Selection): void {
    deps.setSelection(next);
    if (next.kind === "request") deps.setTabs((current) => openTab(current, next));
  }

  function closeTab(requestId: string): void {
    const closed = closeTabAt(deps.tabs, deps.selection, requestId);
    deps.setTabs(closed.tabs);
    if (closed.selection !== undefined) deps.setSelection(closed.selection);
  }

  // --- colecciones, peticiones y ambientes ---

  function createCollection(): void {
    if (!workspace) return;
    const next = appendCollection(workspace);
    deps.setWorkspace(next.workspace);
    choose(next.selection);
  }

  function createRequestIn(collectionId: string): void {
    if (!workspace) return;
    const next = appendRequest(workspace, collectionId);
    deps.setWorkspace(next.workspace);
    choose(next.selection);
  }

  function deleteCollection(collectionId: string): void {
    if (!workspace) return;
    if (!window.confirm("¿Eliminar esta colección?")) return;
    deps.setWorkspace(removeCollection(workspace, collectionId));
  }

  function deleteRequest(collectionId: string, requestId: string): void {
    if (!window.confirm("¿Eliminar esta petición?")) return;
    deps.setWorkspace((current) => (current ? removeRequestIn(current, collectionId, requestId) : current));
    closeTab(requestId);
  }

  function duplicateRequestIn(collectionId: string, requestId: string): void {
    if (!workspace) return;
    const next = duplicateRequest(workspace, collectionId, requestId);
    if (!next) return;
    deps.setWorkspace(next.workspace);
    choose(next.selection);
  }

  function moveRequest(collectionId: string, requestId: string, delta: number): void {
    deps.setWorkspace((current) => (current ? moveRequestIn(current, collectionId, requestId, delta) : current));
  }

  function updateRequest(collectionId: string, request: Parameters<typeof updateRequestIn>[2]): void {
    deps.setWorkspace((current) => (current ? updateRequestIn(current, collectionId, request) : current));
  }

  function createEnvironment(): void {
    if (!workspace) return;
    const next = appendEnvironment(workspace);
    deps.setWorkspace(next.workspace);
    deps.setSelection(next.selection);
  }

  function deleteEnvironment(environmentId: string): void {
    if (!workspace) return;
    const next = removeEnvironment(workspace, environmentId);
    if (!next) {
      notify("Deja al menos un ambiente");
      return;
    }
    deps.setWorkspace(next);
    deps.setSelection(null);
  }

  function updateEnvironment(environment: Parameters<typeof updateEnvironmentIn>[1]): void {
    if (!workspace) return;
    deps.setWorkspace(updateEnvironmentIn(workspace, environment));
  }

  // --- importación ---

  async function importArea(file: File): Promise<void> {
    try {
      const raw = JSON.parse(await file.text()) as unknown;
      if (importKind.current === "postman") {
        const collection = importPostman(raw);
        deps.setWorkspace((current) => (current ? appendCollectionRaw(current, collection) : current));
        const request = collection.requests[0];
        if (request) choose({ kind: "request", collectionId: collection.id, requestId: request.id });
        notify(`Importada la colección ${collection.name}`);
        return;
      }
      const parsed = parseWorkspace(raw);
      if (!window.confirm("Esto reemplaza colecciones, ambientes e historial de esta área.")) return;
      adopt(parsed, dir, true);
      notify("Área importada");
    } catch (error) {
      notify(error instanceof SyntaxError ? "El archivo no es JSON" : error instanceof Error ? error.message : "No se pudo importar");
    }
  }

  function beginImport(kind: "area" | "postman"): void {
    importKind.current = kind;
    importRef.current?.click();
  }

  return {
    hydrated,
    workspaceRef,
    importRef,
    saveNow,
    adopt,
    openArea,
    createArea,
    exportArea,
    choose,
    closeTab,
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
    importArea,
    beginImport,
  };
}
