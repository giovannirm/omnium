import { useRef, type Dispatch, type SetStateAction } from "react";
import type { Client } from "../../client.ts";
import { externalHooks } from "../../core/script.ts";
import type { ExecutionResult, LoadPlan, LoadSnapshot, Workspace } from "../../core/types.ts";
import { resolveVariables } from "../../core/variables.ts";
import {
  activeEnvironment,
  applyEnvironmentChanges,
  diffVars,
  failedResult,
  historyEntry,
  locate,
  withHistory,
  type Selection,
} from "./model.ts";

export type Pane = "response" | "tests" | "load";
export type LoadState = { running: boolean; points: number[]; snap: LoadSnapshot | null };
export type SessionReport = { collectionId: string; report: Awaited<ReturnType<Client["run"]>> };

export const DEFAULT_PLAN: LoadPlan = {
  concurrency: 10,
  rampUpMs: 1000,
  durationMs: 8000,
  timeoutMs: 5000,
  pauseMs: 0,
  maxErrorPct: 1,
  maxP95Ms: 500,
};

export type ExecutionActions = ReturnType<typeof createExecutionActions>;

/** Dominio ejecución: enviar/probar peticiones, resultados, informes de sesión
 * y arranque de carga. El ref `busy` serializa las corridas como antes. */
export function createExecutionActions(deps: {
  client: Client;
  workspace: Workspace | null;
  dir: string | null;
  selection: Selection | null;
  variables: Record<string, string>;
  runtime: Record<string, string>;
  load: LoadState;
  plan: LoadPlan;
  setWorkspace: Dispatch<SetStateAction<Workspace | null>>;
  setResults: Dispatch<SetStateAction<Record<string, ExecutionResult>>>;
  setReport: Dispatch<SetStateAction<SessionReport | null>>;
  setRuntime: Dispatch<SetStateAction<Record<string, string>>>;
  setPending: Dispatch<SetStateAction<boolean>>;
  setPane: Dispatch<SetStateAction<Pane>>;
  setLoad: Dispatch<SetStateAction<LoadState>>;
  notify: (message: string, ms?: number) => void;
  refreshCookies: () => Promise<void>;
}) {
  const { client, workspace, dir, variables, runtime, load, plan, notify, refreshCookies } = deps;
  const selected = locate(workspace, deps.selection);
  const busy = useRef(false);

  function remember(request: Parameters<typeof historyEntry>[0], result: ExecutionResult): void {
    deps.setWorkspace((current) => (current ? withHistory(current, historyEntry(request, result)) : current));
  }

  async function send(asTest = false): Promise<void> {
    if (!workspace || selected?.kind !== "request" || busy.current) return;
    busy.current = true;
    deps.setPending(true);
    deps.setPane(asTest ? "tests" : "response");
    try {
      const environment = activeEnvironment(workspace);
      const result = await client.execute({
        request: selected.request,
        variables,
        ...externalHooks(selected.collection, environment),
        environment: environment?.variables,
        moduleDir: dir,
      });
      deps.setResults((current) => ({ ...current, [selected.request.id]: result }));
      deps.setRuntime((current) => ({ ...current, ...result.extracted }));
      remember(selected.request, result);
      applyEnv(environment?.id, result.environmentChanged);
      if (result.error) notify(result.error);
      void refreshCookies();
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo enviar";
      deps.setResults((current) => ({ ...current, [selected.request.id]: failedResult(selected.request, message) }));
      notify(message);
    } finally {
      busy.current = false;
      deps.setPending(false);
    }
  }

  /** Los scripts que escribieron en el ambiente lo devuelven como diff. */
  function applyEnv(environmentId: string | undefined, changes: Record<string, string> | undefined): void {
    if (!environmentId || !changes || Object.keys(changes).length === 0) return;
    deps.setWorkspace((current) => (current ? applyEnvironmentChanges(current, environmentId, changes) : current));
  }

  async function testCollection(collectionId: string): Promise<void> {
    if (!workspace || busy.current) return;
    const collection = workspace.collections.find((item) => item.id === collectionId);
    if (!collection) return;
    busy.current = true;
    deps.setPending(true);
    deps.setPane("tests");
    try {
      const environment = activeEnvironment(workspace);
      const runVars = resolveVariables(environment, runtime, {
        globals: workspace.globals,
        collection: collection.variables,
      });
      const next = await client.run({
        requests: collection.requests,
        variables: runVars,
        ...externalHooks(collection, environment),
        environment: environment?.variables,
        moduleDir: dir,
      });
      const fresh: Record<string, ExecutionResult> = {};
      for (const step of next.steps) fresh[step.requestId] = step.result;
      deps.setResults((current) => ({ ...current, ...fresh }));
      deps.setReport({ collectionId, report: next });
      deps.setRuntime((current) => ({ ...current, ...diffVars(runVars, next.variables) }));
      applyEnv(environment?.id, next.environmentChanged);
      const cancelled = next.steps.some((step) => step.result.error === "Petición cancelada");
      notify(cancelled ? "Prueba cancelada" : next.failed ? `${next.failed} peticiones fallaron` : `${next.passed} peticiones bien`);
      void refreshCookies();
    } catch (error) {
      notify(error instanceof Error ? error.message : "No se pudo probar la colección");
    } finally {
      busy.current = false;
      deps.setPending(false);
    }
  }

  async function startLoad(): Promise<void> {
    if (selected?.kind !== "request" || load.running || busy.current) return;
    deps.setPane("load");
    deps.setLoad({ running: true, points: [], snap: null });
    try {
      const snap = await client.startLoad({ request: selected.request, variables, plan });
      deps.setLoad((state) => ({ running: false, snap, points: state.points }));
    } catch (error) {
      deps.setLoad((state) => ({ ...state, running: false }));
      notify(error instanceof Error ? error.message : "La carga no arrancó");
    }
  }

  return { send, testCollection, startLoad };
}
