import { HeadlessSessionError } from "./errors.js";
import { AGENT_IDS, type AgentSpec, type AgentTransport } from "./types.js";

/** Default timeout applied to protocol requests that should never hang forever. */
export const CONTROL_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Shared settings handed to runtimes and sessions created by a HeadlessCore.
 */
export type SessionContext = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  manager: RuntimeManager;
};

/**
 * A persistent agent process plus its protocol connection. Runtimes are shared
 * by every session with the same provider/transport/binary and are shut down
 * by the RuntimeManager when the last session closes.
 */
export interface PersistentRuntime {
  readonly alive: boolean;
  /** Called once when the underlying process/connection dies. */
  onExit(handler: (error: HeadlessSessionError) => void): void;
  /** Terminates the process. Idempotent. */
  close(): Promise<void>;
}

const PERSISTENT_TRANSPORTS: Partial<Record<string, readonly AgentTransport[]>> = {
  codex: ["app-server"],
  devin: ["acp"]
};

export function resolveTransport(agent: AgentSpec): AgentTransport {
  return agent.transport ?? "cli";
}

/**
 * Ensures the provider supports the requested transport. `cli` is valid for
 * every provider; persistent transports are provider-specific.
 */
export function validateTransport(provider: string, transport: AgentTransport): void {
  if (transport === "cli") {
    return;
  }
  const supported = PERSISTENT_TRANSPORTS[provider] ?? [];
  if (supported.includes(transport)) {
    return;
  }
  if (!(AGENT_IDS as readonly string[]).includes(provider)) {
    throw new HeadlessSessionError("UNSUPPORTED_TRANSPORT", `Unsupported provider: ${provider}`);
  }
  throw new HeadlessSessionError(
    "UNSUPPORTED_TRANSPORT",
    `Provider "${provider}" does not support transport "${transport}" (supported: cli${supported.length ? `, ${supported.join(", ")}` : ""})`
  );
}

type Entry = {
  runtime: PersistentRuntime;
  refs: number;
};

/**
 * Owns persistent runtimes keyed by provider/transport/binary. Each session
 * holds one reference; the process is killed when the last reference is
 * released or shutdown() runs.
 */
export class RuntimeManager {
  private readonly entries = new Map<string, Entry>();
  private readonly starting = new Map<string, Promise<PersistentRuntime>>();

  /**
   * Returns a live runtime for `key`, starting it if needed. Concurrent
   * acquires share one startup. Each successful call must be paired with
   * `release(key, runtime)`.
   */
  async acquire<T extends PersistentRuntime>(key: string, start: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.runtime.alive) {
        existing.refs += 1;
        return existing.runtime as T;
      }
      this.entries.delete(key);
    }

    let pending = this.starting.get(key);
    if (!pending) {
      pending = start();
      this.starting.set(key, pending);
      pending.finally(() => {
        if (this.starting.get(key) === pending) {
          this.starting.delete(key);
        }
      }).catch(() => undefined);
    }

    const runtime = (await pending) as T;

    const entry = this.entries.get(key);
    if (entry && entry.runtime === runtime) {
      entry.refs += 1;
    } else {
      this.entries.set(key, { runtime, refs: 1 });
      runtime.onExit(() => {
        const current = this.entries.get(key);
        if (current?.runtime === runtime) {
          this.entries.delete(key);
        }
      });
    }
    return runtime;
  }

  /** Releases one reference; kills the runtime when none remain. */
  release(key: string, runtime: PersistentRuntime): void {
    const entry = this.entries.get(key);
    if (!entry || entry.runtime !== runtime) {
      return;
    }
    entry.refs -= 1;
    if (entry.refs <= 0) {
      this.entries.delete(key);
      void runtime.close();
    }
  }

  /** Kills every runtime owned by this manager. Sessions become unusable. */
  async shutdown(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.starting.clear();
    await Promise.all(entries.map((entry) => entry.runtime.close()));
  }
}
