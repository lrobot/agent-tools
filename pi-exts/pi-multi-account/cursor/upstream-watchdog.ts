/**
 * SSE keepalives preserve Pi's client connection even when Cursor stops making progress.
 * Two clocks are intentionally separate:
 *   - every complete decoded Cursor frame proves the HTTP/2 transport is alive;
 *   - only user-visible tokens and Pi-bound tools prove useful model progress.
 * A single one-minute semantic clock killed healthy long-reasoning Runs and falsely looked
 * like exhausted Cursor quota to multi-account.
 */

/** A Run producing no complete upstream frame is treated as dead after one minute. */
export const TRANSPORT_STALL_TIMEOUT_MS = 60_000;
/** A live transport may reason quietly, but housekeeping cannot keep it alive forever. */
export const UPSTREAM_STALL_TIMEOUT_MS = 5 * 60_000;

function resolveTimeout(raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  // Node reduces delays above its signed 32-bit limit to one millisecond.
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) return fallback;
  return parsed;
}

/** `PI_CURSOR_TRANSPORT_STALL_MS` overrides the no-frame window; `0` disables it. */
export function resolveTransportStallTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return resolveTimeout(env.PI_CURSOR_TRANSPORT_STALL_MS, TRANSPORT_STALL_TIMEOUT_MS);
}

/** `PI_CURSOR_UPSTREAM_STALL_MS` overrides the useful-output window; `0` disables it. */
export function resolveUpstreamStallTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return resolveTimeout(env.PI_CURSOR_UPSTREAM_STALL_MS, UPSTREAM_STALL_TIMEOUT_MS);
}

export function formatStallDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

export interface UpstreamWatchdog {
  /** Record decoded upstream progress; the stall deadline moves forward. */
  touch(): void;
  /** Retire the watchdog. Idempotent; later touches are ignored. */
  stop(): void;
}

/**
 * Arm a stall watchdog. `onStall` runs at most once, with how long upstream had been silent.
 * A non-positive `timeoutMs` produces an inert watchdog.
 */
export function startUpstreamWatchdog(onStall: (silentForMs: number) => void, timeoutMs: number): UpstreamWatchdog {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = timeoutMs <= 0;
  let lastProgressAt = performance.now();

  const arm = (delayMs = timeoutMs) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (stopped) return;
      const silentForMs = performance.now() - lastProgressAt;
      // Timers may wake early. Recheck a monotonic deadline before ending the stream.
      if (silentForMs < timeoutMs) { arm(Math.ceil(timeoutMs - silentForMs)); return; }
      stopped = true;
      timer = undefined;
      onStall(silentForMs);
    }, delayMs);
    timer.unref?.();
  };

  arm();

  return {
    touch() {
      if (stopped) return;
      lastProgressAt = performance.now();
      arm();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
