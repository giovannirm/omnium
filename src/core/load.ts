import type { LoadPlan, LoadSnapshot } from "./types.ts";

const SAMPLE_CAP = 50000;

export type LoadAttempt = {
  ok: boolean;
  timeMs: number;
  error?: string | null;
  status: number | null;
};

export function clampPlan(plan: LoadPlan): LoadPlan {
  const durationMs = clamp(plan.durationMs, 500, 180000);
  return {
    concurrency: clamp(plan.concurrency, 1, 100),
    durationMs,
    rampUpMs: clamp(plan.rampUpMs, 0, durationMs),
    timeoutMs: clamp(plan.timeoutMs, 50, 60000),
    pauseMs: clamp(plan.pauseMs, 0, 10000),
    maxErrorPct: clamp(plan.maxErrorPct ?? 5, 0, 100),
    maxP95Ms: clamp(plan.maxP95Ms ?? 0, 0, 120000),
  };
}

export function judgeLoad(snapshot: LoadSnapshot, plan: LoadPlan): { passed: boolean; notes: string[] } {
  const notes: string[] = [];
  const rate = snapshot.sent ? (snapshot.failed / snapshot.sent) * 100 : 0;
  if (snapshot.sent > 0 && rate > plan.maxErrorPct) notes.push(`Errores ${rate.toFixed(1)}% por encima de ${plan.maxErrorPct}%`);
  if (plan.maxP95Ms > 0 && snapshot.p95 > plan.maxP95Ms) {
    notes.push(`p95 ${Math.round(snapshot.p95)} ms por encima de ${plan.maxP95Ms} ms`);
  }
  if (snapshot.sent === 0) notes.push("No hubo respuestas");
  return { passed: notes.length === 0, notes };
}

export async function runLoad(options: {
  plan: LoadPlan;
  signal: AbortSignal;
  runOnce: (signal: AbortSignal) => Promise<LoadAttempt>;
  onTick?: (snapshot: LoadSnapshot) => void;
}): Promise<LoadSnapshot> {
  const plan = clampPlan(options.plan);
  const startedAt = Date.now();
  const latencies: number[] = [];
  const buckets = new Array<number>(10).fill(0);
  let bucketIndex = 0;
  let bucketAt = Date.now();
  const errorCounts = new Map<string, number>();
  let sent = 0;
  let ok = 0;
  let failed = 0;
  let inflight = 0;
  let latencySum = 0;
  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = 0;
  let samplesCapped = false;

  function rotateBuckets(): void {
    const now = Date.now();
    while (now - bucketAt >= 100) {
      bucketIndex = (bucketIndex + 1) % buckets.length;
      buckets[bucketIndex] = 0;
      bucketAt += 100;
      if (now - bucketAt > 2000) {
        buckets.fill(0);
        bucketAt = now;
        break;
      }
    }
  }

  const snapshot = (stopped = false, final = false): LoadSnapshot => {
    rotateBuckets();
    const sample = !final && latencies.length > 8000 ? latencies.filter((_, index) => index % Math.ceil(latencies.length / 8000) === 0) : latencies;
    return {
      elapsedMs: Date.now() - startedAt,
      inflight,
      sent,
      ok,
      failed,
      rps: buckets.reduce((sum, count) => sum + count, 0),
      avgMs: sent ? latencySum / sent : 0,
      minMs: Number.isFinite(minMs) ? minMs : 0,
      maxMs,
      p50: percentile(sample, 50),
      p95: percentile(sample, 95),
      p99: percentile(sample, 99),
      errors: [...errorCounts.entries()]
        .map(([message, count]) => ({ message, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
      samplesCapped,
      stopped,
    };
  };

  const worker = async (startDelay: number) => {
    if (startDelay > 0) await delay(startDelay, options.signal);
    while (!options.signal.aborted && Date.now() - startedAt < plan.durationMs) {
      const attempt = new AbortController();
      const onAbort = () => attempt.abort();
      options.signal.addEventListener("abort", onAbort, { once: true });
      inflight += 1;
      try {
        const result = await options.runOnce(attempt.signal);
        if (options.signal.aborted) return;
        record(result);
      } catch (error) {
        if (options.signal.aborted) return;
        record({
          ok: false,
          timeMs: 0,
          status: null,
          error: error instanceof Error ? error.message : "Error de red",
        });
      } finally {
        inflight = Math.max(0, inflight - 1);
        options.signal.removeEventListener("abort", onAbort);
      }
      if (plan.pauseMs > 0 && !options.signal.aborted && Date.now() - startedAt < plan.durationMs) {
        await delay(plan.pauseMs, options.signal);
      }
    }
  };

  function record(result: LoadAttempt) {
    sent += 1;
    latencySum += result.timeMs;
    minMs = Math.min(minMs, result.timeMs);
    maxMs = Math.max(maxMs, result.timeMs);
    if (latencies.length < SAMPLE_CAP) latencies.push(result.timeMs);
    else samplesCapped = true;
    rotateBuckets();
    buckets[bucketIndex] += 1;
    if (result.ok) ok += 1;
    else {
      failed += 1;
      const message = result.error || (result.status ? `HTTP ${result.status}` : "Error de red");
      errorCounts.set(message, (errorCounts.get(message) ?? 0) + 1);
    }
  }

  const gap = plan.concurrency <= 1 ? 0 : plan.rampUpMs / plan.concurrency;
  const workers = Array.from({ length: plan.concurrency }, (_, index) => worker(gap * index));
  const timer = setInterval(() => options.onTick?.(snapshot(false)), 200);
  try {
    await Promise.all(workers);
  } finally {
    clearInterval(timer);
  }
  const finalSnap = snapshot(options.signal.aborted, true);
  options.onTick?.(finalSnap);
  return finalSnap;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
