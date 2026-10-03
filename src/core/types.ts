export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

export type HttpMethod = (typeof METHODS)[number];

export type Pair = {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  /** El valor se muestra oculto y se exporta enmascarado. */
  secret?: boolean;
};

export type Auth =
  | { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "basic"; username: string; password: string }
  | { type: "apikey"; key: string; value: string; in: "header" | "query" };

export type Assertion = {
  id: string;
  source: "status" | "time" | "header" | "json" | "body";
  op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "contains" | "exists";
  path: string;
  expected: string;
};

export type Extractor = {
  id: string;
  name: string;
  source: "json" | "header";
  path: string;
};

export type RequestModel = {
  id: string;
  name: string;
  description: string;
  method: HttpMethod;
  url: string;
  params: Pair[];
  headers: Pair[];
  bodyMode: "none" | "json" | "text" | "form";
  bodyRaw: string;
  form: Pair[];
  auth: Auth;
  assertions: Assertion[];
  extractors: Extractor[];
  timeoutMs: number;
  followRedirects: boolean;
  /** Script que corre antes de la petición (fase pre). */
  preScript?: string;
  /** Script que corre después de la respuesta (fase post). */
  postScript?: string;
};

export type Environment = {
  id: string;
  name: string;
  variables: Pair[];
  preScript?: string;
  postScript?: string;
};

export type Collection = {
  id: string;
  name: string;
  variables: Pair[];
  requests: RequestModel[];
  preScript?: string;
  postScript?: string;
};

export type HistoryEntry = {
  id: string;
  at: string;
  requestId: string;
  name: string;
  method: string;
  url: string;
  status: number | null;
  timeMs: number;
  ok: boolean;
  error: string | null;
};

export type Workspace = {
  version: 1;
  name: string;
  activeEnvironmentId: string | null;
  globals: Pair[];
  environments: Environment[];
  collections: Collection[];
  history: HistoryEntry[];
};

export type AssertionResult = {
  id: string;
  passed: boolean;
  message: string;
};

export type ExecutionResult = {
  ok: boolean;
  error: string | null;
  requestId: string;
  name: string;
  method: string;
  url: string;
  finalUrl: string;
  status: number | null;
  statusText: string;
  timeMs: number;
  sizeBytes: number;
  headers: { name: string; value: string }[];
  bodyText: string;
  bodyJson: unknown | null;
  binary: boolean;
  truncated: boolean;
  assertions: AssertionResult[];
  extracted: Record<string, string>;
  missing: string[];
  /** Salida de `omnium.log` de los scripts que corrieron en este paso. */
  logs?: string[];
  /** Claves del ambiente que los scripts modificaron; el host las aplica. */
  environmentChanged?: Record<string, string>;
};

export type StepReport = {
  requestId: string;
  name: string;
  passed: boolean;
  result: ExecutionResult;
};

export type CollectionReport = {
  steps: StepReport[];
  passed: number;
  failed: number;
  variables: Record<string, string>;
  /** Cambios de ambiente acumulados en toda la corrida. */
  environmentChanged?: Record<string, string>;
};

export type LoadPlan = {
  concurrency: number;
  rampUpMs: number;
  durationMs: number;
  timeoutMs: number;
  pauseMs: number;
  maxErrorPct: number;
  maxP95Ms: number;
};

export type LoadError = {
  message: string;
  count: number;
};

export type LoadSnapshot = {
  elapsedMs: number;
  inflight: number;
  sent: number;
  ok: number;
  failed: number;
  rps: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50: number;
  p95: number;
  p99: number;
  errors: LoadError[];
  samplesCapped: boolean;
  stopped: boolean;
};

/** Gancho de script externo (ambiente o colección) con etiqueta para errores y UI. */
export type ScriptHook = { label: string; code: string };

export type ExecutePayload = {
  request: RequestModel;
  variables: Record<string, string>;
  /** Hooks externos: `pre` corre antes del script de la petición, `post` después. */
  pre?: ScriptHook[];
  post?: ScriptHook[];
  /** Pares del ambiente activo; los scripts `omnium.env.*` leen y escriben esta capa. */
  environment?: Pair[];
  /** Directorio del área en disco; los hosts con Node lo usan para armar `omnium.require`. */
  moduleDir?: string | null;
  /** Adjunto en proceso por el host; JSON (HTTP) lo descarta. */
  requireModule?: (specifier: string) => unknown;
};

export type RunPayload = {
  requests: RequestModel[];
  variables: Record<string, string>;
  pre?: ScriptHook[];
  post?: ScriptHook[];
  environment?: Pair[];
  moduleDir?: string | null;
  requireModule?: (specifier: string) => unknown;
};

export type LoadPayload = {
  request: RequestModel;
  variables: Record<string, string>;
  plan: LoadPlan;
};
