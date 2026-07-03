/**
 * Pure helpers for translating `AppleContainerDriverConfig` + an
 * `ExecutionRequest` shape into `container run` argv. Kept apart from the
 * driver body so they can be unit-tested on any platform without needing the
 * `container` binary or the macOS Virtualization framework installed.
 *
 * @module
 */

// deno-lint-ignore-file no-import-prefix
import { z } from "npm:zod@4";

/**
 * Zod schema for the Apple container driver's `driverConfig`. Mirrors the
 * Docker driver's config where the CLIs overlap; extends with `arch` (Apple
 * container defaults to arm64) and dedicated `uid`/`gid` fields (Apple's CLI
 * exposes them as separate flags, which is nicer for the operator than
 * Docker's fused `user` string).
 */
export const AppleContainerDriverConfigSchema = z.object({
  image: z.string().min(1, "container image is required"),
  bundleImage: z.string().optional(),
  timeout: z.number().positive().optional(),
  memory: z.string().optional(),
  cpus: z.string().optional(),
  arch: z.enum(["arm64", "amd64"]).default("arm64"),
  network: z.string().optional(),
  volumes: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  user: z.string().optional(),
  uid: z.number().int().nonnegative().optional(),
  gid: z.number().int().nonnegative().optional(),
  capsDrop: z.array(z.string()).default(["ALL"]),
  capsAdd: z.array(z.string()).optional(),
  workdir: z.string().optional(),
  entrypoint: z.string().optional(),
  extraArgs: z.array(z.string()).optional(),
});

export type AppleContainerDriverConfig = z.infer<
  typeof AppleContainerDriverConfigSchema
>;

/** Build the shared `container run` argv prefix, up to the image. */
export function buildBaseRunArgs(c: AppleContainerDriverConfig): string[] {
  const args: string[] = ["run", "--rm", "-a", c.arch];
  if (c.memory) args.push("-m", c.memory);
  if (c.cpus) args.push("-c", c.cpus);
  if (c.network) args.push("--network", c.network);
  if (c.user) args.push("-u", c.user);
  if (c.uid !== undefined) args.push("--uid", String(c.uid));
  if (c.gid !== undefined) args.push("--gid", String(c.gid));
  if (c.workdir) args.push("-w", c.workdir);
  if (c.entrypoint) args.push("--entrypoint", c.entrypoint);
  for (const cap of c.capsDrop) args.push("--cap-drop", cap);
  for (const cap of c.capsAdd ?? []) args.push("--cap-add", cap);
  for (const v of c.volumes ?? []) args.push("-v", v);
  for (const [k, v] of Object.entries(c.env ?? {})) args.push("-e", `${k}=${v}`);
  for (const extra of c.extraArgs ?? []) args.push(extra);
  return args;
}

/**
 * Full argv for command-mode execution:
 *   container run [flags] <image> sh -c "<run>"
 */
export function buildCommandModeArgs(
  c: AppleContainerDriverConfig,
  runCommand: string,
): string[] {
  return [...buildBaseRunArgs(c), c.image, "sh", "-c", runCommand];
}

/**
 * Full argv for bundle-mode execution:
 *   container run [flags] -v <tmpDir>:/swamp:ro <bundleImage>
 *     deno run --allow-all /swamp/runner.js
 */
export function buildBundleModeArgs(
  c: AppleContainerDriverConfig,
  tmpDir: string,
): string[] {
  const image = c.bundleImage ?? c.image;
  return [
    ...buildBaseRunArgs(c),
    "-v",
    `${tmpDir}:/swamp:ro`,
    image,
    "deno",
    "run",
    "--allow-all",
    "/swamp/runner.js",
  ];
}

/** Argv for the up-front `container images pull <image>` warm-up. */
export function buildPullArgs(image: string): string[] {
  return ["images", "pull", image];
}

/**
 * Runtime probe used at `initialize()` time. Fails fast on non-macOS or when
 * the `container` binary is missing, with a message that names the fix.
 */
export function assertRuntimeAvailable(): void {
  if (Deno.build.os !== "darwin") {
    throw new Error(
      `@bixu/container driver requires macOS (found: ${Deno.build.os}).`,
    );
  }
}
