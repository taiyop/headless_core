import { HeadlessSessionError } from "./errors.js";

type Json = Record<string, unknown>;

type PendingRequest = {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
};

type NotificationHandler = (method: string, params: unknown) => void;

/**
 * Handles requests initiated by the server (e.g. approval prompts). Return the
 * result payload, or throw to reply with a JSON-RPC error.
 */
type RequestHandler = (method: string, params: unknown) => unknown | Promise<unknown>;

type CloseHandler = (error: HeadlessSessionError) => void;

const STDERR_TAIL_LIMIT = 8192;

/**
 * Newline-delimited JSON-RPC 2.0 over a child process's stdin/stdout.
 *
 * Used by both persistent transports: `codex app-server` and ACP agents such as
 * `devin acp` speak the same framing (one JSON object per line).
 *
 * Server-initiated requests are dispatched to the handler set via
 * `setRequestHandler`; notifications go to `setNotificationHandler`. When the
 * process exits or the stream dies, every pending request rejects and the
 * `onClose` handlers run.
 */
export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private buffer = "";
  private stderrTail = "";
  private closeError: HeadlessSessionError | undefined;
  private notificationHandler: NotificationHandler | undefined;
  private requestHandler: RequestHandler | undefined;
  private readonly closeHandlers = new Set<CloseHandler>();

  constructor(
    private readonly name: string,
    private readonly streams: {
      stdin: NodeJS.WritableStream;
      stdout: NodeJS.ReadableStream;
      stderr?: NodeJS.ReadableStream;
    }
  ) {
    streams.stdout.setEncoding("utf8");
    streams.stdout.on("data", (chunk: string) => this.accept(chunk));
    streams.stderr?.setEncoding("utf8");
    streams.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });
    streams.stdout.on("error", (cause) => this.fail(errorFrom(cause)));
    streams.stdin.on("error", () => {
      // EPIPE while writing to a dead child: the close/error path handles it.
    });
  }

  get closed(): boolean {
    return this.closeError !== undefined;
  }

  get stderr(): string {
    return this.stderrTail;
  }

  setNotificationHandler(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  setRequestHandler(handler: RequestHandler): void {
    this.requestHandler = handler;
  }

  onClose(handler: CloseHandler): void {
    if (this.closeError) {
      handler(this.closeError);
      return;
    }
    this.closeHandlers.add(handler);
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closeError) {
      return Promise.reject(this.closeError);
    }

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: PendingRequest = {
        method,
        resolve: (result) => resolve(result as T),
        reject
      };
      if (timeoutMs !== undefined) {
        entry.timeout = setTimeout(() => {
          this.pending.delete(id);
          reject(new HeadlessSessionError("REQUEST_TIMEOUT", `${this.name}: request "${method}" timed out`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /**
   * Stops dispatching and rejects pending requests. The caller owns process
   * teardown; this only severs the protocol layer.
   */
  dispose(): void {
    this.fail(new HeadlessSessionError("SESSION_CLOSED", `${this.name}: connection closed`));
  }

  private send(message: Json): void {
    if (this.closeError) {
      return;
    }
    try {
      this.streams.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // The child is gone; its close path reports the failure.
    }
  }

  private accept(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        this.dispatchLine(line);
      }
    }
  }

  private dispatchLine(line: string): void {
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      return;
    }

    const method = typeof message.method === "string" ? message.method : undefined;
    const hasId = message.id !== undefined && message.id !== null;

    if (method && hasId) {
      void this.answerRequest(message.id as number | string, method, message.params);
      return;
    }
    if (method) {
      this.notificationHandler?.(method, message.params);
      return;
    }
    if (hasId) {
      this.settleResponse(message.id as number | string, message);
    }
  }

  private async answerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    if (!this.requestHandler) {
      this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported server request: ${method}` } });
      return;
    }

    try {
      const result = await this.requestHandler(method, params);
      this.send({ jsonrpc: "2.0", id, result: result ?? {} });
    } catch (cause) {
      this.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: cause instanceof Error ? cause.message : String(cause) }
      });
    }
  }

  private settleResponse(id: number | string, message: Json): void {
    const entry = this.pending.get(id);
    if (!entry) {
      return;
    }
    this.pending.delete(id);
    if (entry.timeout) {
      clearTimeout(entry.timeout);
    }

    const error = message.error as { code?: unknown; message?: unknown } | undefined;
    if (error) {
      const text = typeof error.message === "string" ? error.message : JSON.stringify(error);
      entry.reject(new HeadlessSessionError("PROTOCOL_ERROR", `${this.name}: ${entry.method} failed: ${text}`));
      return;
    }
    entry.resolve(message.result);
  }

  /** Marks the peer dead: rejects pending requests and notifies close handlers. */
  fail(error: HeadlessSessionError): void {
    if (this.closeError) {
      return;
    }
    this.closeError = error;

    for (const [id, entry] of this.pending) {
      if (entry.timeout) {
        clearTimeout(entry.timeout);
      }
      entry.reject(error);
      this.pending.delete(id);
    }

    for (const handler of this.closeHandlers) {
      handler(error);
    }
    this.closeHandlers.clear();
  }
}

export function errorFrom(cause: unknown): HeadlessSessionError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new HeadlessSessionError("PROTOCOL_ERROR", message, { cause });
}
