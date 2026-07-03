/**
 * Unit tests for pure CLI helpers. These run on any platform — no `container`
 * binary or macOS Virtualization framework required.
 *
 * @module
 */

import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  AppleContainerDriverConfigSchema,
  assertRuntimeAvailable,
  buildBaseRunArgs,
  buildBundleModeArgs,
  buildCommandModeArgs,
  buildPullArgs,
} from "./cli.ts";

const MINIMAL = AppleContainerDriverConfigSchema.parse({
  image: "docker.io/library/alpine:latest",
});

Deno.test("schema: defaults arch=arm64, capsDrop=[ALL]", () => {
  assertEquals(MINIMAL.arch, "arm64");
  assertEquals(MINIMAL.capsDrop, ["ALL"]);
});

Deno.test("schema: rejects empty image", () => {
  const result = AppleContainerDriverConfigSchema.safeParse({ image: "" });
  assertEquals(result.success, false);
});

Deno.test("schema: rejects arch outside enum", () => {
  const result = AppleContainerDriverConfigSchema.safeParse({
    image: "alpine",
    arch: "riscv64",
  });
  assertEquals(result.success, false);
});

Deno.test("buildBaseRunArgs: minimal config emits arch + rm + cap-drop", () => {
  assertEquals(
    buildBaseRunArgs(MINIMAL),
    ["run", "--rm", "-a", "arm64", "--cap-drop", "ALL"],
  );
});

Deno.test("buildBaseRunArgs: emits memory, cpus, network, workdir", () => {
  const c = AppleContainerDriverConfigSchema.parse({
    image: "alpine",
    memory: "512m",
    cpus: "1.5",
    network: "bridge",
    workdir: "/work",
  });
  const args = buildBaseRunArgs(c);
  assertEquals(args.includes("-m"), true);
  assertEquals(args[args.indexOf("-m") + 1], "512m");
  assertEquals(args[args.indexOf("-c") + 1], "1.5");
  assertEquals(args[args.indexOf("--network") + 1], "bridge");
  assertEquals(args[args.indexOf("-w") + 1], "/work");
});

Deno.test("buildBaseRunArgs: uid/gid emit --uid / --gid as separate flags", () => {
  const c = AppleContainerDriverConfigSchema.parse({
    image: "alpine",
    uid: 1000,
    gid: 1000,
  });
  const args = buildBaseRunArgs(c);
  assertEquals(args[args.indexOf("--uid") + 1], "1000");
  assertEquals(args[args.indexOf("--gid") + 1], "1000");
});

Deno.test("buildBaseRunArgs: user (fused name) coexists with uid/gid override", () => {
  const c = AppleContainerDriverConfigSchema.parse({
    image: "alpine",
    user: "app",
    uid: 1000,
  });
  const args = buildBaseRunArgs(c);
  assertEquals(args.includes("-u"), true);
  assertEquals(args.includes("--uid"), true);
});

Deno.test("buildBaseRunArgs: entrypoint override lands as --entrypoint", () => {
  const c = AppleContainerDriverConfigSchema.parse({
    image: "alpine",
    entrypoint: "/usr/local/bin/init",
  });
  const args = buildBaseRunArgs(c);
  assertEquals(args[args.indexOf("--entrypoint") + 1], "/usr/local/bin/init");
});

Deno.test("buildBaseRunArgs: capsAdd appends --cap-add per capability", () => {
  const c = AppleContainerDriverConfigSchema.parse({
    image: "alpine",
    capsDrop: ["ALL"],
    capsAdd: ["NET_BIND_SERVICE", "CHOWN"],
  });
  const args = buildBaseRunArgs(c);
  const addFlags = args.filter((a, i) => a === "--cap-add" && args[i + 1]);
  assertEquals(addFlags.length, 2);
  assertEquals(args.includes("NET_BIND_SERVICE"), true);
  assertEquals(args.includes("CHOWN"), true);
});

Deno.test("buildBaseRunArgs: volumes emit -v pairs in declared order", () => {
  const c = AppleContainerDriverConfigSchema.parse({
    image: "alpine",
    volumes: ["/host/a:/container/a", "/host/b:/container/b:ro"],
  });
  const args = buildBaseRunArgs(c);
  const idxA = args.indexOf("/host/a:/container/a");
  const idxB = args.indexOf("/host/b:/container/b:ro");
  assertEquals(idxA > 0 && args[idxA - 1] === "-v", true);
  assertEquals(idxB > idxA, true);
});

Deno.test("buildBaseRunArgs: env pairs land as KEY=VAL after -e", () => {
  const c = AppleContainerDriverConfigSchema.parse({
    image: "alpine",
    env: { FOO: "bar", BAZ: "qux" },
  });
  const args = buildBaseRunArgs(c);
  const eIndexes = args.map((a, i) => (a === "-e" ? i : -1)).filter((i) => i >= 0);
  assertEquals(eIndexes.length, 2);
  const values = eIndexes.map((i) => args[i + 1]).sort();
  assertEquals(values, ["BAZ=qux", "FOO=bar"]);
});

Deno.test("buildBaseRunArgs: extraArgs append verbatim at the end", () => {
  const c = AppleContainerDriverConfigSchema.parse({
    image: "alpine",
    extraArgs: ["--label", "team=platform", "--dns", "1.1.1.1"],
  });
  const args = buildBaseRunArgs(c);
  const tail = args.slice(-4);
  assertEquals(tail, ["--label", "team=platform", "--dns", "1.1.1.1"]);
});

Deno.test("buildCommandModeArgs: image, sh, -c, and command land in order", () => {
  const args = buildCommandModeArgs(MINIMAL, "echo hello");
  const imageIdx = args.indexOf(MINIMAL.image);
  assertEquals(args[imageIdx + 1], "sh");
  assertEquals(args[imageIdx + 2], "-c");
  assertEquals(args[imageIdx + 3], "echo hello");
});

Deno.test("buildCommandModeArgs: passes the -c argument as one token (no shell splitting)", () => {
  const args = buildCommandModeArgs(MINIMAL, "echo 'a b'; echo c");
  const shellArg = args[args.length - 1];
  assertEquals(shellArg, "echo 'a b'; echo c");
});

Deno.test("buildBundleModeArgs: mounts tmp dir at /swamp:ro and runs runner", () => {
  const args = buildBundleModeArgs(MINIMAL, "/tmp/swamp-xyz");
  const vIdx = args.indexOf("-v");
  assertEquals(args[vIdx + 1], "/tmp/swamp-xyz:/swamp:ro");
  const tail = args.slice(-4);
  assertEquals(tail, ["deno", "run", "--allow-all", "/swamp/runner.js"]);
});

Deno.test("buildBundleModeArgs: uses bundleImage when set, falls back to image", () => {
  const cWith = AppleContainerDriverConfigSchema.parse({
    image: "alpine",
    bundleImage: "denoland/deno:alpine",
  });
  const argsWith = buildBundleModeArgs(cWith, "/tmp");
  const idxWith = argsWith.indexOf("denoland/deno:alpine");
  assertEquals(idxWith >= 0, true);

  const argsWithout = buildBundleModeArgs(MINIMAL, "/tmp");
  const idxWithout = argsWithout.indexOf(MINIMAL.image);
  assertEquals(idxWithout >= 0, true);
});

Deno.test("buildPullArgs: images pull <image>", () => {
  assertEquals(
    buildPullArgs("docker.io/library/alpine:latest"),
    ["images", "pull", "docker.io/library/alpine:latest"],
  );
});

Deno.test("assertRuntimeAvailable: throws with a helpful message off-darwin", () => {
  if (Deno.build.os === "darwin") return;
  assertThrows(
    () => assertRuntimeAvailable(),
    Error,
    "requires macOS",
  );
});
