import { HeadlessSessionError } from "./errors.js";
import type { AgentSpec, HeadlessError, HeadlessSessionRunOptions, ProgressEvent } from "./types.js";

/**
 * How long to wait for the agent to report the interrupted turn's terminal
 * event before letting the next queued run proceed anyway.
 */
const INTERRUPT_GRACE_MS = 10_000;

export type TurnSettlement = {
  /**
   * Caller-facing result. Rejects promptly on abort/timeout, without waiting
   * for the agent to confirm the interruption.
   */
  result: Promise<string>;
  /**
   * Internal lifecycle promise: resolves when the turn is truly over (remote
   * completion observed, or the interrupt grace elapsed). The per-session
   * mutex waits on this so a new turn never races a still-running one.
   */
  done: Promise<void>;
  /** Whether the caller was cut off by abort/timeout. */
  readonly interrupted: boolean;
  /** Terminal success observed from the agent. */
  complete(output: string): void;
  /** Terminal failure observed from the agent. */
  fail(error: HeadlessSessionError): void;
  /**
   * Rejects the caller now but keeps `done` pending until the remote end is
   * observed (or the interrupt grace elapses). For non-terminal error signals
   * that precede the real completion event.
   */
  rejectSoon(error: HeadlessSessionError): void;
};

/**
 * Wires a single in-flight turn to an AbortSignal and a timeout.
 *
 * On abort/timeout the caller's promise rejects immediately and `interrupt()`
 * (a best-effort remote cancel: codex `turn/interrupt`, ACP `session/cancel`)
 * is fired. `done` stays pending until the adapter reports the remote end —
 * or a grace period elapses — so the serialized session queue releases only
 * once the agent is reusable.
 */
export function startTurn(options: {
  timeoutMs: number;
  signal?: AbortSignal;
  interrupt: () => void;
}): TurnSettlement {
  let resolveResult!: (output: string) => void;
  let rejectResult!: (error: Error) => void;
  let resolveDone!: () => void;

  const result = new Promise<string>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  let resultSettled = false;
  let doneResolved = false;
  let interrupted = false;

  const finishDone = () => {
    if (doneResolved) {
      return;
    }
    doneResolved = true;
    clearTimeout(timeout);
    clearTimeout(grace);
    options.signal?.removeEventListener("abort", onAbort);
    resolveDone();
  };

  const settleResult = (settle: () => void) => {
    if (!resultSettled) {
      resultSettled = true;
      settle();
    }
  };

  const interrupt = (error: HeadlessSessionError) => {
    interrupted = true;
    settleResult(() => rejectResult(error));
    try {
      options.interrupt();
    } catch {
      // Best-effort remote cancel; the grace timer unblocks the queue.
    }
    if (!doneResolved && !grace) {
      grace = setTimeout(finishDone, INTERRUPT_GRACE_MS);
    }
  };

  const onAbort = () => interrupt(new HeadlessSessionError("REQUEST_ABORTED", "Run aborted"));
  const timeout = setTimeout(
    () => interrupt(new HeadlessSessionError("REQUEST_TIMEOUT", `Run timed out after ${options.timeoutMs}ms`)),
    options.timeoutMs
  );
  let grace: NodeJS.Timeout | undefined;

  if (options.signal?.aborted) {
    queueMicrotask(onAbort);
  } else {
    options.signal?.addEventListener("abort", onAbort, { once: true });
  }

  return {
    result,
    done,
    get interrupted() {
      return interrupted;
    },
    complete(output) {
      settleResult(() => resolveResult(output));
      finishDone();
    },
    fail(error) {
      settleResult(() => rejectResult(error));
      finishDone();
    },
    rejectSoon(error) {
      interrupted = true;
      settleResult(() => rejectResult(error));
      if (!doneResolved && !grace) {
        grace = setTimeout(finishDone, INTERRUPT_GRACE_MS);
      }
    }
  };
}

export function emitSessionProgress(
  options: HeadlessSessionRunOptions,
  agent: AgentSpec,
  event: Omit<ProgressEvent, "agent">
): void {
  try {
    // A throwing user callback must not break the protocol dispatch loop or
    // surface as an unhandled rejection inside a .then chain.
    void Promise.resolve(options.onProgress?.({ ...event, agent })).catch(() => undefined);
  } catch {
    // ignore
  }
}

/** Maps session failures onto the HeadlessError kinds used by run(). */
export function sessionErrorKind(error: HeadlessSessionError): HeadlessError["kind"] {
  switch (error.code) {
    case "REQUEST_ABORTED":
    case "REQUEST_TIMEOUT":
      return "agent_stopped";
    default:
      return classifyMessage(error.message);
  }
}

function classifyMessage(message: string): HeadlessError["kind"] {
  const normalized = message.toLowerCase();
  if (normalized.includes("rate limit") || normalized.includes("429")) {
    return "rate_limit";
  }
  if (normalized.includes("network") || normalized.includes("econnrefused") || normalized.includes("etimedout")) {
    return "network";
  }
  return "unknown";
}
