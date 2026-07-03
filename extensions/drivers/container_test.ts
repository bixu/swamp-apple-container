/**
 * Driver-level tests. Config-schema + `driver` export shape is covered here on
 * every platform; the actual `container run` smoke test is gated behind
 * SWAMP_APPLE_CONTAINER_SMOKE=1 so CI on ubuntu-latest doesn't skip on the
 * missing binary — we opt in from a self-hosted macOS runner.
 *
 * @module
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { driver } from "./container.ts";

Deno.test("driver export: type/name/description/configSchema/createDriver are present", () => {
  assertEquals(driver.type, "@bixu/container");
  assert(typeof driver.name === "string" && driver.name.length > 0);
  assert(typeof driver.description === "string" && driver.description.length > 0);
  assert(typeof driver.configSchema.parse === "function");
  assert(typeof driver.createDriver === "function");
});

Deno.test("driver.type matches swamp's USER_DRIVER_TYPE_PATTERN (single-slash scope/name)", () => {
  const USER_DRIVER_TYPE_PATTERN = /^@?[a-z0-9_-]+\/[a-z0-9_-]+$/;
  assert(USER_DRIVER_TYPE_PATTERN.test(driver.type));
});

Deno.test("createDriver rejects invalid config (empty image)", () => {
  let threw = false;
  try {
    driver.createDriver({ image: "" });
  } catch (_e) {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("createDriver returns an object with an execute method", () => {
  const d = driver.createDriver({ image: "docker.io/library/alpine:latest" });
  assertEquals(d.type, "@bixu/container");
  assert(typeof d.execute === "function");
  assert(typeof d.initialize === "function");
});

Deno.test("execute() with no bundle and no run string returns an error result", async () => {
  const d = driver.createDriver({ image: "docker.io/library/alpine:latest" });
  const result = await d.execute({
    protocolVersion: 1,
    modelType: "@test/x",
    modelId: "test-model",
    methodName: "noop",
    globalArgs: {},
    methodArgs: {},
    definitionMeta: { id: "id", name: "n", version: 1, tags: {} },
  });
  assertEquals(result.status, "error");
  assert(typeof result.error === "string");
  assert(result.error!.includes("requires either a bundle or a 'run' string"));
});

Deno.test({
  name: "smoke: container run alpine echo hello (macOS + container CLI required)",
  ignore: Deno.env.get("SWAMP_APPLE_CONTAINER_SMOKE") !== "1",
  fn: async () => {
    const d = driver.createDriver({
      image: "docker.io/library/alpine:latest",
      arch: "arm64",
      capsDrop: ["ALL"],
    });
    const result = await d.execute({
      protocolVersion: 1,
      modelType: "@test/x",
      modelId: "test-model",
      methodName: "hello",
      globalArgs: {},
      methodArgs: { run: "echo hello" },
      definitionMeta: { id: "id", name: "n", version: 1, tags: {} },
    });
    assertEquals(result.status, "success");
    assertEquals(result.outputs.length, 1);
    const output = result.outputs[0];
    assert(output.kind === "pending");
    const text = new TextDecoder().decode(output.content).trim();
    assertEquals(text, "hello");
  },
});
