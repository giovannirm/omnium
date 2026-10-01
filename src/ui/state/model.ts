import { stepPassed } from "../../core/assertions.ts";
import { createRequest, uid } from "../../core/factory.ts";
import type {
  Collection,
  Environment,
  ExecutionResult,
  HistoryEntry,
  Pair,
  RequestModel,
  Workspace,
} from "../../core/types.ts";

export const MAX_HISTORY = 40;
export const MAX_TABS = 10;

export type Selection =
  | { kind: "request"; collectionId: string; requestId: string }
  | { kind: "environment"; environmentId: string }
  | { kind: "globals" }
  | { kind: "collection"; collectionId: string };

export type Tab = { collectionId: string; requestId: string };

export type Located =
  | { kind: "request"; collection: Collection; request: RequestModel }
  | { kind: "environment"; environment: Environment }
  | { kind: "collection"; collection: Collection }
  | { kind: "globals" };

export function locate(workspace: Workspace | null, selection: Selection | null): Located | null {
  if (!workspace || !selection) return null;
  if (selection.kind === "globals") return { kind: "globals" };
  if (selection.kind === "environment") {
    const environment = workspace.environments.find((item) => item.id === selection.environmentId);
    return environment ? { kind: "environment", environment } : null;
  }
  if (selection.kind === "collection") {
    const collection = workspace.collections.find((item) => item.id === selection.collectionId);
    return collection ? { kind: "collection", collection } : null;
  }
  const collection = workspace.collections.find((item) => item.id === selection.collectionId);
  const request = collection?.requests.find((item) => item.id === selection.requestId);
  if (!collection || !request) return null;
  return { kind: "request", collection, request };
}

export function defaultSelection(workspace: Workspace): Selection | null {
  const request = workspace.collections[0]?.requests[0];
  const collectionId = workspace.collections[0]?.id;
  return request && collectionId ? { kind: "request", collectionId, requestId: request.id } : null;
}

export function pruneTabs(tabs: Tab[], workspace: Workspace): Tab[] {
  const alive = new Set(workspace.collections.flatMap((collection) => collection.requests.map((request) => request.id)));
  const next = tabs.filter((tab) => alive.has(tab.requestId));
  return next.length === tabs.length ? tabs : next;
}

export function pruneSelection(selection: Selection | null, workspace: Workspace): Selection | null {
  if (!selection || selection.kind === "globals") return selection;
  if (selection.kind === "request") {
    const collection = workspace.collections.find((item) => item.id === selection.collectionId);
    if (!collection?.requests.some((request) => request.id === selection.requestId)) return null;
  }
  if (selection.kind === "collection" && !workspace.collections.some((item) => item.id === selection.collectionId)) return null;
  if (selection.kind === "environment" && !workspace.environments.some((item) => item.id === selection.environmentId)) return null;
  return selection;
}

export function openTab(tabs: Tab[], next: Tab): Tab[] {
  return [...tabs.filter((tab) => tab.requestId !== next.requestId), next].slice(-MAX_TABS);
}

export function toTab(selection: Selection | null): Tab | null {
  return selection?.kind === "request"
    ? { collectionId: selection.collectionId, requestId: selection.requestId }
    : null;
}

export function closeTabAt(
  tabs: Tab[],
  selection: Selection | null,
  requestId: string,
): { tabs: Tab[]; selection?: Selection | null } {
  const index = tabs.findIndex((tab) => tab.requestId === requestId);
  const next = tabs.filter((tab) => tab.requestId !== requestId);
  if (!(selection?.kind === "request" && selection.requestId === requestId)) return { tabs: next };
  const neighbor = next[Math.min(index, next.length - 1)] ?? null;
  return {
    tabs: next,
    selection: neighbor ? { kind: "request", collectionId: neighbor.collectionId, requestId: neighbor.requestId } : null,
  };
}

export function historyEntry(request: RequestModel, result: ExecutionResult): HistoryEntry {
  return {
    id: uid("hist"),
    at: new Date().toISOString(),
    requestId: request.id,
    name: request.name,
    method: request.method,
    url: result.url || request.url,
    status: result.status,
    timeMs: result.timeMs,
    ok: stepPassed(result),
    error: result.error,
  };
}

export function withHistory(workspace: Workspace, entry: HistoryEntry): Workspace {
  return { ...workspace, history: [entry, ...workspace.history].slice(0, MAX_HISTORY) };
}

export function diffVars(before: Record<string, string>, after: Record<string, string>): Record<string, string> {
  const changed: Record<string, string> = {};
  for (const [key, value] of Object.entries(after)) {
    if (before[key] !== value) changed[key] = value;
  }
  return changed;
}

export function failedResult(request: RequestModel, message: string): ExecutionResult {
  return {
    ok: false,
    error: message,
    requestId: request.id,
    name: request.name,
    method: request.method,
    url: request.url,
    finalUrl: request.url,
    status: null,
    statusText: "",
    timeMs: 0,
    sizeBytes: 0,
    headers: [],
    bodyText: "",
    bodyJson: null,
    binary: false,
    truncated: false,
    assertions: [],
    extracted: {},
    missing: [],
  };
}

export function appendCollection(
  workspace: Workspace,
  name = "Nueva colección",
): { workspace: Workspace; selection: Selection } {
  const id = uid("col");
  const request = createRequest({ name: "Nueva petición", method: "GET", url: "" });
  const collection: Collection = { id, name, variables: [], requests: [request] };
  return {
    workspace: { ...workspace, collections: [...workspace.collections, collection] },
    selection: { kind: "request", collectionId: id, requestId: request.id },
  };
}

export function appendRequest(
  workspace: Workspace,
  collectionId: string,
  partial: Partial<RequestModel> = {},
): { workspace: Workspace; selection: Selection } {
  const request = createRequest(partial);
  return {
    workspace: updateCollection(workspace, collectionId, (collection) => ({
      ...collection,
      requests: [...collection.requests, request],
    })),
    selection: { kind: "request", collectionId, requestId: request.id },
  };
}

export function duplicateRequest(
  workspace: Workspace,
  collectionId: string,
  requestId: string,
): { workspace: Workspace; selection: Selection } | null {
  const source = workspace.collections.find((item) => item.id === collectionId)?.requests.find((item) => item.id === requestId);
  if (!source) return null;
  const copy = createRequest({
    ...structuredClone(source),
    id: uid("req"),
    name: `${source.name} copia`,
    assertions: source.assertions.map((item) => ({ ...item, id: uid("assert") })),
    extractors: source.extractors.map((item) => ({ ...item, id: uid("extract") })),
  });
  return {
    workspace: updateCollection(workspace, collectionId, (collection) => {
      const index = collection.requests.findIndex((item) => item.id === requestId);
      const requests = [...collection.requests];
      requests.splice(index + 1, 0, copy);
      return { ...collection, requests };
    }),
    selection: { kind: "request", collectionId, requestId: copy.id },
  };
}

export function updateRequestIn(
  workspace: Workspace,
  collectionId: string,
  request: RequestModel,
): Workspace {
  return updateCollection(workspace, collectionId, (collection) => ({
    ...collection,
    requests: collection.requests.map((item) => (item.id === request.id ? request : item)),
  }));
}

export function removeRequestIn(workspace: Workspace, collectionId: string, requestId: string): Workspace {
  return updateCollection(workspace, collectionId, (collection) => ({
    ...collection,
    requests: collection.requests.filter((request) => request.id !== requestId),
  }));
}

export function moveRequestIn(
  workspace: Workspace,
  collectionId: string,
  requestId: string,
  delta: number,
): Workspace {
  return updateCollection(workspace, collectionId, (collection) => {
    const index = collection.requests.findIndex((item) => item.id === requestId);
    const next = index + delta;
    if (index < 0 || next < 0 || next >= collection.requests.length) return collection;
    const requests = [...collection.requests];
    const [item] = requests.splice(index, 1);
    if (!item) return collection;
    requests.splice(next, 0, item);
    return { ...collection, requests };
  });
}

export function updateCollection(
  workspace: Workspace,
  collectionId: string,
  change: (collection: Collection) => Collection,
): Workspace {
  return {
    ...workspace,
    collections: workspace.collections.map((collection) => (collection.id === collectionId ? change(collection) : collection)),
  };
}

export function removeCollection(workspace: Workspace, collectionId: string): Workspace {
  return { ...workspace, collections: workspace.collections.filter((item) => item.id !== collectionId) };
}

export function setCollectionVariables(workspace: Workspace, collectionId: string, rows: Pair[]): Workspace {
  return updateCollection(workspace, collectionId, (collection) => ({ ...collection, variables: rows }));
}

export function setGlobals(workspace: Workspace, rows: Pair[]): Workspace {
  return { ...workspace, globals: rows };
}

export function appendEnvironment(
  workspace: Workspace,
  name = "Nuevo ambiente",
): { workspace: Workspace; selection: Selection } {
  const environment: Environment = { id: uid("env"), name, variables: [] };
  return {
    workspace: { ...workspace, environments: [...workspace.environments, environment] },
    selection: { kind: "environment", environmentId: environment.id },
  };
}

/** Devuelve `null` cuando la operación no está permitida (último ambiente). */
export function removeEnvironment(workspace: Workspace, environmentId: string): Workspace | null {
  if (workspace.environments.length < 2) return null;
  const environments = workspace.environments.filter((item) => item.id !== environmentId);
  return {
    ...workspace,
    environments,
    activeEnvironmentId:
      workspace.activeEnvironmentId === environmentId ? (environments[0]?.id ?? null) : workspace.activeEnvironmentId,
  };
}

export function updateEnvironmentIn(workspace: Workspace, environment: Environment): Workspace {
  return {
    ...workspace,
    environments: workspace.environments.map((item) => (item.id === environment.id ? environment : item)),
  };
}

export function appendCollectionRaw(workspace: Workspace, collection: Collection): Workspace {
  return { ...workspace, collections: [...workspace.collections, collection] };
}

export function activeEnvironment(workspace: Workspace | null): Environment | null {
  if (!workspace) return null;
  return workspace.environments.find((item) => item.id === workspace.activeEnvironmentId) ?? workspace.environments[0] ?? null;
}
