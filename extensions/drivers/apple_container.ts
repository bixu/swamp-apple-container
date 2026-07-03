/**
 * # @bixu/apple-container
 *
 * Swamp execution driver that routes every model method through Apple's
 * `container` CLI (macOS 15+). Each execution runs inside its own
 * Virtualization-framework microVM — a materially stronger isolation boundary
 * than Docker's shared-kernel containers, and the right default for
 * agentic / LLM-driven / untrusted-code workloads.
 *
 * Modelled on swamp's built-in `docker` driver. Two execution modes:
 *
 * - **Bundle mode** — when the request carries a self-contained JS bundle,
 *   the driver mounts `bundle.js`, `request.json`, and a runner into `/swamp/`
 *   and invokes `deno run --allow-all /swamp/runner.js` inside a Deno-capable
 *   image.
 * - **Command mode** — when `methodArgs.run` is a non-empty string, the driver
 *   runs `sh -c "<command>"` inside the container. Stdout becomes the
 *   `stdout` resource; stderr streams as real-time logs.
 *
 * Set `defaultDriver: "@bixu/apple-container"` in `.swamp.yaml` (or on a
 * workflow / job / step / model) to opt in. See the README for a full
 * example.
 *
 * @module
 */

// deno-lint-ignore-file no-import-prefix
import {
  type AppleContainerDriverConfig,
  AppleContainerDriverConfigSchema,
  assertRuntimeAvailable,
  buildBundleModeArgs,
  buildCommandModeArgs,
  buildPullArgs,
} from "./_lib/cli.ts";

// Runner script embedded in the bundle mount. Kept in-line so the driver has
// no runtime dependency on a sibling file at install time; the bundle inlines
// it. Same shape as swamp's built-in Docker runner: reads request.json, imports
// the bundle, wires a mock context that captures writeResource() and
// createFileWriter(), executes the method, and outputs { resources, files }
// JSON on stdout. Content mirrors DOCKER_RUNNER_SCRIPT in swamp source
// (src/domain/drivers/docker_runner.ts) verbatim; extension bundlers inline
// this string, so keeping it self-contained here is required.
const APPLE_CONTAINER_RUNNER_SCRIPT = `
import { readFileSync } from "node:fs";
const request = JSON.parse(readFileSync("/swamp/request.json", "utf-8"));
const bundle = await import("/swamp/bundle.js");
const resources = [];
const files = [];
const ctx = {
  globalArgs: request.globalArgs,
  methodArgs: request.methodArgs,
  definition: request.definitionMeta,
  logger: {
    debug: (msg, props) => console.error(JSON.stringify({ level: "debug", msg, props })),
    info:  (msg, props) => console.error(JSON.stringify({ level: "info",  msg, props })),
    warn:  (msg, props) => console.error(JSON.stringify({ level: "warn",  msg, props })),
    error: (msg, props) => console.error(JSON.stringify({ level: "error", msg, props })),
  },
  writeResource: async (specName, name, data, tags) => {
    const content = new TextEncoder().encode(JSON.stringify(data));
    resources.push({ specName, name, content: Array.from(content), tags: tags ?? {} });
    return { name };
  },
  createFileWriter: (specName, name, contentType, tags) => ({
    writeAll: async (bytes) => {
      files.push({ specName, name, contentType, content: Array.from(bytes), tags: tags ?? {} });
    },
    writeText: async (text) => {
      const bytes = new TextEncoder().encode(text);
      files.push({ specName, name, contentType, content: Array.from(bytes), tags: tags ?? {} });
    },
    writeStream: async () => { throw new Error("streaming writes not supported in bundle mode"); },
  }),
  getFilePath: () => { throw new Error("getFilePath not supported in bundle mode"); },
};
const model = bundle.model ?? bundle.default;
const method = model?.methods?.[request.methodName];
if (!method) throw new Error("method not found: " + request.methodName);
const result = await method.execute(request.methodArgs, ctx);
process.stdout.write(JSON.stringify({ resources, files, result }));
`;

/** DriverOutput from swamp's execution-driver interface. */
type DriverOutput =
  | { kind: "persisted"; handle: unknown }
  | {
    kind: "pending";
    specName: string;
    name: string;
    type: "resource" | "file";
    content: Uint8Array;
    tags?: Record<string, string>;
    metadata?: Record<string, unknown>;
  };

/** ExecutionResult from swamp's execution-driver interface. */
interface ExecutionResult {
  status: "success" | "error";
  error?: string;
  outputs: DriverOutput[];
  logs: string[];
  durationMs: number;
  followUpActions?: unknown[];
}

/** ExecutionRequest from swamp's execution-driver interface. */
interface ExecutionRequest {
  protocolVersion: number;
  modelType: string;
  modelId: string;
  methodName: string;
  globalArgs: Record<string, unknown>;
  methodArgs: Record<string, unknown>;
  definitionMeta: {
    id: string;
    name: string;
    version: number;
    tags: Record<string, string>;
  };
  resourceSpecs?: Record<string, unknown>;
  fileSpecs?: Record<string, unknown>;
  bundle?: Uint8Array;
  traceHeaders?: Record<string, string>;
}

/** ExecutionCallbacks from swamp's execution-driver interface. */
interface ExecutionCallbacks {
  onLog?: (line: string) => void;
  onResourceWritten?: (handle: unknown) => void;
}

/** ExecutionDriver from swamp's execution-driver interface. */
interface ExecutionDriver {
  readonly type: string;
  execute(
    request: ExecutionRequest,
    callbacks?: ExecutionCallbacks,
  ): Promise<ExecutionResult>;
  initialize?(): Promise<void>;
  shutdown?(): Promise<void>;
}

/** Grace period before SIGKILL after SIGTERM on timeout. */
const SIGKILL_GRACE_MS = 5_000;

/**
 * Apple container execution driver — runs model methods in per-call
 * Virtualization-framework microVMs via Apple's `container` CLI.
 */
class AppleContainerExecutionDriver implements ExecutionDriver {
  readonly type = "@bixu/apple-container";
  private readonly config: AppleContainerDriverConfig;

  constructor(rawConfig: Record<string, unknown>) {
    this.config = AppleContainerDriverConfigSchema.parse(rawConfig);
  }

  async initialize(): Promise<void> {
    assertRuntimeAvailable();
    // Warm-cache the runtime image so the first execute() doesn't pay the
    // pull cost inside its timeout budget. Failure is non-fatal — the CLI
    // will just pull on demand on the first run and log the delay to
    // callbacks.onLog.
    const images = [this.config.image];
    if (this.config.bundleImage && this.config.bundleImage !== this.config.image) {
      images.push(this.config.bundleImage);
    }
    for (const image of images) {
      try {
        await runProcess("container", buildPullArgs(image));
      } catch (_e) {
        // ignore; per-run pull is the fallback
      }
    }
  }

  execute(
    request: ExecutionRequest,
    callbacks?: ExecutionCallbacks,
  ): Promise<ExecutionResult> {
    const hasBundle = request.bundle !== undefined && request.bundle.length > 0;
    const hasRun = typeof request.methodArgs.run === "string" &&
      (request.methodArgs.run as string).trim() !== "";

    if (hasBundle) return this.executeBundle(request, callbacks);
    if (hasRun) return this.executeCommand(request, callbacks);
    return Promise.resolve({
      status: "error",
      error:
        "@bixu/apple-container driver requires either a bundle or a 'run' string in methodArgs",
      outputs: [],
      logs: [],
      durationMs: 0,
    });
  }

  private async executeCommand(
    request: ExecutionRequest,
    callbacks?: ExecutionCallbacks,
  ): Promise<ExecutionResult> {
    const runCmd = request.methodArgs.run as string;
    const args = buildCommandModeArgs(this.config, runCmd);
    const started = performance.now();
    const result = await runProcess("container", args, {
      timeoutMs: this.config.timeout,
      onStderrLine: (line) => callbacks?.onLog?.(line),
    });
    const durationMs = performance.now() - started;
    if (result.code !== 0) {
      return {
        status: "error",
        error: `container run exited ${result.code}: ${result.stderr.slice(0, 500)}`,
        outputs: [],
        logs: result.stderrLines,
        durationMs,
      };
    }
    // Command-mode: wrap stdout as a single `stdout` resource, mirroring the
    // docker driver's contract.
    return {
      status: "success",
      outputs: [
        {
          kind: "pending",
          specName: "stdout",
          name: request.methodName,
          type: "resource",
          content: new TextEncoder().encode(result.stdout),
          metadata: { exitCode: result.code, durationMs },
        },
      ],
      logs: result.stderrLines,
      durationMs,
    };
  }

  private async executeBundle(
    request: ExecutionRequest,
    callbacks?: ExecutionCallbacks,
  ): Promise<ExecutionResult> {
    const tmp = await Deno.makeTempDir({ prefix: "swamp-apple-container-" });
    try {
      await Deno.writeFile(`${tmp}/bundle.js`, request.bundle!);
      await Deno.writeTextFile(
        `${tmp}/request.json`,
        JSON.stringify({
          modelType: request.modelType,
          modelId: request.modelId,
          methodName: request.methodName,
          globalArgs: request.globalArgs,
          methodArgs: request.methodArgs,
          definitionMeta: request.definitionMeta,
        }),
      );
      await Deno.writeTextFile(`${tmp}/runner.js`, APPLE_CONTAINER_RUNNER_SCRIPT);

      const args = buildBundleModeArgs(this.config, tmp);
      const started = performance.now();
      const result = await runProcess("container", args, {
        timeoutMs: this.config.timeout,
        onStderrLine: (line) => callbacks?.onLog?.(line),
      });
      const durationMs = performance.now() - started;

      if (result.code !== 0) {
        return {
          status: "error",
          error: `container run exited ${result.code}: ${result.stderr.slice(0, 500)}`,
          outputs: [],
          logs: result.stderrLines,
          durationMs,
        };
      }

      // Parse the runner's JSON envelope from stdout.
      let parsed: {
        resources?: Array<{
          specName: string;
          name: string;
          content: number[];
          tags?: Record<string, string>;
        }>;
        files?: Array<{
          specName: string;
          name: string;
          contentType?: string;
          content: number[];
          tags?: Record<string, string>;
        }>;
      };
      try {
        parsed = JSON.parse(result.stdout);
      } catch (e) {
        return {
          status: "error",
          error: `runner output was not JSON: ${(e as Error).message}`,
          outputs: [],
          logs: result.stderrLines,
          durationMs,
        };
      }

      const outputs: DriverOutput[] = [];
      for (const r of parsed.resources ?? []) {
        outputs.push({
          kind: "pending",
          specName: r.specName,
          name: r.name,
          type: "resource",
          content: Uint8Array.from(r.content),
          tags: r.tags,
        });
      }
      for (const f of parsed.files ?? []) {
        outputs.push({
          kind: "pending",
          specName: f.specName,
          name: f.name,
          type: "file",
          content: Uint8Array.from(f.content),
          tags: f.tags,
        });
      }
      return {
        status: "success",
        outputs,
        logs: result.stderrLines,
        durationMs,
      };
    } finally {
      try {
        await Deno.remove(tmp, { recursive: true });
      } catch (_e) {
        // Best-effort cleanup.
      }
    }
  }
}

/** Result envelope from `runProcess`. */
interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  stderrLines: string[];
}

/**
 * Spawn a subprocess, capture stdout, stream stderr line-by-line, enforce a
 * timeout with a SIGTERM → SIGKILL escalation.
 */
async function runProcess(
  command: string,
  args: string[],
  opts?: { timeoutMs?: number; onStderrLine?: (line: string) => void },
): Promise<ProcessResult> {
  const cmd = new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let kill: ReturnType<typeof setTimeout> | undefined;
  if (opts?.timeoutMs) {
    timeoutHandle = setTimeout(() => {
      try {
        child.kill("SIGTERM");
        kill = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch (_e) {
            // process already exited
          }
        }, SIGKILL_GRACE_MS);
      } catch (_e) {
        // process already exited
      }
    }, opts.timeoutMs);
  }

  // Consume both streams concurrently, then wait for exit. Using
  // `child.output()` after we've already taken a lock on stderr fails with
  // "Cannot collect output: 'stderr' is locked" (Deno tracks locks per
  // stream). Reading both streams ourselves — and awaiting `child.status`
  // separately — is the deno-native shape.
  const stderrLines: string[] = [];
  const stdoutBufs: Uint8Array[] = [];
  const stdoutCapture = collectStream(child.stdout, (chunk) => {
    stdoutBufs.push(chunk);
  });
  const stderrCapture = streamLines(child.stderr, (line) => {
    stderrLines.push(line);
    opts?.onStderrLine?.(line);
  });

  const [status] = await Promise.all([child.status, stdoutCapture, stderrCapture]);
  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  if (kill !== undefined) clearTimeout(kill);

  const totalLen = stdoutBufs.reduce((n, b) => n + b.length, 0);
  const stdoutBytes = new Uint8Array(totalLen);
  let offset = 0;
  for (const b of stdoutBufs) {
    stdoutBytes.set(b, offset);
    offset += b.length;
  }

  return {
    code: status.code,
    stdout: new TextDecoder().decode(stdoutBytes),
    stderr: stderrLines.join("\n"),
    stderrLines,
  };
}

async function collectStream(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => void,
): Promise<void> {
  for await (const chunk of stream) onChunk(chunk);
}

async function streamLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const line of parts) onLine(line);
  }
  buf += decoder.decode();
  if (buf.length > 0) onLine(buf);
}

/**
 * User-driver export. Swamp's `UserDriverLoader` discovers this on load
 * and registers the driver type against the extension's model catalog.
 */
export const driver = {
  type: "@bixu/apple-container",
  name: "Apple container (macOS)",
  description:
    "Executes model methods in macOS Virtualization-framework microVMs via Apple's `container` CLI. Each method runs in a fresh, isolated microVM — a stronger isolation boundary than Docker's shared-kernel containers.",
  configSchema: AppleContainerDriverConfigSchema,
  createDriver(config: Record<string, unknown>): ExecutionDriver {
    return new AppleContainerExecutionDriver(config);
  },
};

// Re-exports for testing.
export {
  APPLE_CONTAINER_RUNNER_SCRIPT,
  AppleContainerDriverConfigSchema,
  AppleContainerExecutionDriver,
};
export type { AppleContainerDriverConfig };
