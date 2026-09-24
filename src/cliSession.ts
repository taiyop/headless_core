import { HeadlessSessionError } from "./errors.js";
import { getAvailableModels } from "./modelAvailability.js";
import type {
  AgentSpec,
  Effort,
  HeadlessRunOptions,
  HeadlessSession,
  HeadlessSessionRunOptions,
  ModelCandidate
} from "./types.js";

/**
 * A HeadlessSession backed by the one-shot CLI transport.
 *
 * Every run() spawns a fresh CLI process, exactly like headless.run() — there
 * is no conversation continuity, and reset() is a no-op because nothing
 * persists. This exists so callers can use the session API uniformly across
 * providers regardless of transport support.
 */
export class CliSession implements HeadlessSession {
  readonly transport = "cli" as const;
  readonly id = null;

  private closed = false;
  private busy: Promise<void> = Promise.resolve();

  constructor(
    private agent: AgentSpec,
    private readonly runner: (options: HeadlessRunOptions) => Promise<string>
  ) {}

  get provider(): string {
    return this.agent.provider;
  }

  run(options: HeadlessSessionRunOptions): Promise<string> {
    // Serialize turns for parity with the persistent transports.
    const op = this.busy.then(() => this.runOnce(options));
    this.busy = op.then(
      () => undefined,
      () => undefined
    );
    return op;
  }

  reset(): Promise<void> {
    this.assertUsable();
    return Promise.resolve();
  }

  async setModel(model: string, reasoningEffort?: Effort | (string & {})): Promise<void> {
    this.assertUsable();
    this.agent = {
      ...this.agent,
      model,
      reasoningEffort: reasoningEffort ?? this.agent.reasoningEffort
    };
  }

  async getAvailableModels(): Promise<ModelCandidate[]> {
    this.assertUsable();
    const models = await getAvailableModels({ agent: this.agent.provider });
    return models.map((id) => ({ id }));
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  private async runOnce(options: HeadlessSessionRunOptions): Promise<string> {
    this.assertUsable();
    return this.runner({
      agent: this.agent,
      prompt: options.prompt,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      onProgress: options.onProgress
    });
  }

  private assertUsable(): void {
    if (this.closed) {
      throw new HeadlessSessionError("SESSION_CLOSED", "Session is closed");
    }
  }
}
