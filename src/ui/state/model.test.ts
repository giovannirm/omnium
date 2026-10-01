import assert from "node:assert/strict";
import { test } from "node:test";
import { sampleWorkspace } from "../../core/sample.ts";
import type { Workspace } from "../../core/types.ts";
import {
  appendCollection,
  appendEnvironment,
  appendRequest,
  closeTabAt,
  defaultSelection,
  diffVars,
  duplicateRequest,
  failedResult,
  historyEntry,
  locate,
  moveRequestIn,
  openTab,
  pruneSelection,
  pruneTabs,
  removeEnvironment,
  updateRequestIn,
  withHistory,
} from "./model.ts";

function base(): Workspace {
  return sampleWorkspace();
}

test("la selección por defecto apunta a la primera petición", () => {
  const workspace = base();
  const selection = defaultSelection(workspace);
  assert.deepEqual(selection, {
    kind: "request",
    collectionId: workspace.collections[0]!.id,
    requestId: workspace.collections[0]!.requests[0]!.id,
  });
  const located = locate(workspace, selection);
  assert.equal(located?.kind, "request");
});

test("las selecciones y pestañas de entidades borradas se depuran", () => {
  const workspace = base();
  const alive = workspace.collections[0]!.requests[0]!.id;
  const tabs = [
    { collectionId: workspace.collections[0]!.id, requestId: alive },
    { collectionId: workspace.collections[0]!.id, requestId: "req-fantasma" },
  ];
  assert.equal(pruneTabs(tabs, workspace).length, 1);
  assert.equal(pruneSelection({ kind: "request", collectionId: tabs[0]!.collectionId, requestId: "req-fantasma" }, workspace), null);
  assert.equal(pruneSelection({ kind: "globals" }, workspace)?.kind, "globals");
});

test("cerrar la pestaña activa salta a la vecina", () => {
  const workspace = base();
  const first = workspace.collections[0]!.requests[0]!.id;
  const second = workspace.collections[0]!.requests[1]!.id;
  const collectionId = workspace.collections[0]!.id;
  const tabs = [
    { collectionId, requestId: first },
    { collectionId, requestId: second },
  ];
  const closed = closeTabAt(tabs, { kind: "request", collectionId, requestId: first }, first);
  assert.equal(closed.tabs.length, 1);
  assert.deepEqual(closed.selection, { kind: "request", collectionId, requestId: second });
  const idle = closeTabAt(tabs, { kind: "globals" }, first);
  assert.equal(idle.selection, undefined);
});

test("abrir una pestaña repetida la mueve al final sin pasarse del tope", () => {
  const tabs = Array.from({ length: 10 }, (_, index) => ({ collectionId: "col", requestId: `req-${index}` }));
  const next = openTab(tabs, { collectionId: "col", requestId: "req-3" });
  assert.equal(next.length, 10);
  assert.equal(next[9]?.requestId, "req-3");
});

test("el historial queda ordenado y acotado", () => {
  const workspace = base();
  const request = workspace.collections[0]!.requests[0]!;
  const first = historyEntry(request, failedResult(request, "boom"));
  const withOne = withHistory(workspace, first);
  assert.equal(withOne.history[0]?.error, "boom");
  let full = withOne;
  for (let index = 0; index < 45; index += 1) {
    full = withHistory(full, historyEntry(request, failedResult(request, `error-${index}`)));
  }
  assert.equal(full.history.length, 40);
  assert.equal(full.history[0]?.error, "error-44");
});

test("duplicar una petición regala ids nuevos", () => {
  const workspace = base();
  const source = workspace.collections[0]!.requests.find((item) => item.assertions.length > 0) ?? workspace.collections[0]!.requests[0]!;
  const done = duplicateRequest(workspace, workspace.collections[0]!.id, source.id);
  if (!done) throw new Error("no duplicó");
  const copyId = done.selection.kind === "request" ? done.selection.requestId : null;
  const copy = done.workspace.collections[0]!.requests.find((item) => item.id === copyId);
  assert.ok(copy);
  assert.notEqual(copy.id, source.id);
  assert.equal(copy.name, `${source.name} copia`);
  assert.notEqual(copy.assertions[0]?.id, source.assertions[0]?.id);
});

test("mover una petición respeta los límites", () => {
  const workspace = base();
  const collectionId = workspace.collections[0]!.id;
  const first = workspace.collections[0]!.requests[0]!.id;
  const original = workspace.collections[0]!.requests.map((item) => item.id);
  assert.deepEqual(moveRequestIn(workspace, collectionId, first, -1).collections[0]!.requests.map((item) => item.id), original);
  const moved = moveRequestIn(workspace, collectionId, first, 1);
  assert.equal(moved.collections[0]!.requests[1]?.id, first);
});

test("no se puede eliminar el último ambiente y el activo se reubica", () => {
  const workspace = base();
  const only = workspace.environments[0]!.id;
  const envs = workspace.environments.map((item, index) => (index === 0 ? { ...item, id: "env-a" } : item));
  const withTwo: Workspace = { ...workspace, environments: envs, activeEnvironmentId: "env-a" };
  assert.equal(removeEnvironment(withTwo, "env-a")?.activeEnvironmentId, envs[1]?.id);
  const one: Workspace = { ...workspace, environments: [withTwo.environments[0]!], activeEnvironmentId: "env-a" };
  assert.equal(removeEnvironment(one, "env-a"), null);
  assert.ok(only);
});

test("agregar colección, petición y ambiente selecciona lo nuevo", () => {
  const workspace = base();
  const collection = appendCollection(workspace);
  assert.equal(collection.selection.kind, "request");
  const request = appendRequest(collection.workspace, collection.selection.kind === "request" ? collection.selection.collectionId : "");
  assert.equal(request.selection.kind, "request");
  const environment = appendEnvironment(collection.workspace);
  assert.equal(environment.selection.kind, "environment");
});

test("actualizar una petición aislada no toca a las demás", () => {
  const workspace = base();
  const target = workspace.collections[0]!.requests[0]!;
  const next = updateRequestIn(workspace, workspace.collections[0]!.id, { ...target, name: "Renombrada" });
  assert.equal(next.collections[0]!.requests[0]?.name, "Renombrada");
  assert.equal(next.collections[0]!.requests[1]?.name, workspace.collections[0]!.requests[1]?.name);
});

test("diffVars solo devuelve lo que cambió", () => {
  assert.deepEqual(diffVars({ a: "1", b: "2" }, { a: "1", b: "3", c: "4" }), { b: "3", c: "4" });
});
