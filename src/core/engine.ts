import { CookieJar, type CookieView } from "./cookies.ts";
import { executeRequest } from "./execute.ts";
import { clampPlan, runLoad } from "./load.ts";
import { runCollection } from "./runner.ts";
import type {
  CollectionReport,
  ExecutePayload,
  ExecutionResult,
  LoadPayload,
  LoadSnapshot,
  RunPayload,
} from "./types.ts";

export type EngineEvents = {
  onTick?: (snapshot: LoadSnapshot) => void;
};

/**
 * Runtime único del motor: concentra el jar de cookies, la cancelación de
 * peticiones HTTP y la ejecución de cargas. Los hosts (Electron IPC, servidor
 * HTTP, CLI) son adaptadores delgados sobre esta clase, nunca la reimplementan.
 */
export class EngineRuntime {
  readonly jar = new CookieJar();
  private http: AbortController | null = null;
  private load: AbortController | null = null;

  async execute(payload: ExecutePayload, signal?: AbortSignal): Promise<ExecutionResult> {
    if (!payload?.request) throw new Error("La petición está incompleta");
    return this.trackHttp(signal, (active) =>
      executeRequest({
        request: payload.request,
        variables: payload.variables ?? {},
        jar: this.jar,
        persistCookies: true,
        signal: active,
      }),
    );
  }

  async run(payload: RunPayload, signal?: AbortSignal): Promise<CollectionReport> {
    if (!payload?.requests) throw new Error("La colección está incompleta");
    return this.trackHttp(signal, (active) =>
      runCollection({
        requests: payload.requests,
        variables: payload.variables ?? {},
        jar: this.jar,
        signal: active,
      }),
    );
  }

  cancelHttp(): void {
    this.http?.abort();
  }

  /**
   * Ejecuta una carga y devuelve el snapshot final. Arrancar una carga nueva
   * cancela la anterior; el snapshot devuelto lleva `stopped: true` si se cortó.
   */
  async startLoad(payload: LoadPayload, events: EngineEvents = {}): Promise<LoadSnapshot> {
    if (!payload?.request) throw new Error("La carga está incompleta");
    this.stopLoad();
    const controller = new AbortController();
    this.load = controller;
    const plan = clampPlan(payload.plan);
    const frozen = this.jar.clone();
    try {
      return await runLoad({
        plan,
        signal: controller.signal,
        onTick: events.onTick,
        runOnce: async (signal) => {
          const result = await executeRequest({
            request: { ...payload.request, timeoutMs: plan.timeoutMs },
            variables: payload.variables ?? {},
            jar: frozen,
            persistCookies: false,
            captureBody: false,
            signal,
          });
          return {
            ok: !result.error && result.status !== null && result.status < 400,
            timeMs: result.timeMs,
            status: result.status,
            error: result.error,
          };
        },
      });
    } finally {
      if (this.load === controller) this.load = null;
    }
  }

  stopLoad(): void {
    this.load?.abort();
  }

  listCookies(): CookieView[] {
    return this.jar.list();
  }

  clearCookies(): void {
    this.jar.clear();
  }

  /**
   * Si el host pasa su propia señal (cierre de conexión, por ejemplo) se usa
   * esa; si no, el runtime crea y registra un controlador cancelable con
   * `cancelHttp()`.
   */
  private async trackHttp<T>(hostSignal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (hostSignal) return run(hostSignal);
    const controller = new AbortController();
    this.http = controller;
    try {
      return await run(controller.signal);
    } finally {
      if (this.http === controller) this.http = null;
    }
  }
}
