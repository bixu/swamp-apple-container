# @bixu/apple-container

Swamp execution driver that routes every model method through Apple's `container` CLI (macOS 15+). Each execution runs in its own Virtualization-framework microVM — a stronger isolation boundary than Docker's shared-kernel containers.

## Why

`docker` on macOS runs containers inside a single Linux VM managed by Docker Desktop. All containers share one kernel. A compromised method (LLM-driven shell exec, third-party extension code) can potentially reach the host through the shared kernel or the Docker socket.

Apple's `container` runs each container inside its own microVM via the macOS Virtualization framework. Fresh kernel, fresh rootfs, per-invocation. Escape requires a hypervisor escape, not a Linux kernel escape.

For workflows that run untrusted or LLM-generated code, this is a real security upgrade — same posture Firecracker gives cloud providers for multi-tenant execution.

## Requirements

- macOS 15 (Sequoia) or later on Apple Silicon
- Apple's `container` CLI installed at `/usr/local/bin/container` (v1.0+)
- A container image with Deno for bundle-mode execution

## Install

```
swamp extension pull @bixu/apple-container --channel beta
```

## Opt in

The driver replaces the default `raw` in-process driver for whatever scope you point it at. Set it repo-wide in `.swamp.yaml`:

```yaml
defaultDriver: "@bixu/apple-container"
defaultDriverConfig:
  image: docker.io/library/alpine:latest
  bundleImage: docker.io/denoland/deno:alpine
  cpus: "2"
  memory: "1g"
  arch: arm64
  capsDrop: ["ALL"]
  uid: 1000
  gid: 1000
```

Or per-workflow, per-job, per-step, per-model — same resolution chain the built-in drivers follow (CLI flag > step > job > workflow > definition > repo > default).

Override for a single run:

```
swamp workflow run my-workflow --driver "@bixu/apple-container"
```

## Config schema

| Field         | Type                     | Default   | Notes                                                                                           |
| ------------- | ------------------------ | --------- | ----------------------------------------------------------------------------------------------- |
| `image`       | `string`                 | required  | OCI image for command-mode                                                                      |
| `bundleImage` | `string`                 | `image`   | Image for bundle-mode. Must have Deno available.                                                |
| `timeout`     | `number`                 | none      | Per-execute timeout in ms; SIGTERM then SIGKILL after a 5 s grace                               |
| `memory`      | `string`                 | none      | Passed as `-m` (e.g. `512m`, `1g`)                                                              |
| `cpus`        | `string`                 | none      | Passed as `-c`                                                                                  |
| `arch`        | `"arm64" \| "amd64"`     | `"arm64"` | Apple Silicon default; opt-in `amd64` for cross-arch                                            |
| `network`     | `string`                 | none      | Passed as `--network`                                                                           |
| `volumes`     | `string[]`               | none      | Each entry becomes a `-v HOST:CONTAINER[:MODE]` pair                                            |
| `env`         | `Record<string, string>` | none      | Each entry becomes `-e KEY=VAL`                                                                 |
| `user`        | `string`                 | none      | Passed as `-u name\|uid[:gid]`                                                                  |
| `uid`         | `number`                 | none      | Passed as `--uid`; can combine with `user`                                                      |
| `gid`         | `number`                 | none      | Passed as `--gid`                                                                               |
| `capsDrop`    | `string[]`               | `["ALL"]` | Passed as repeated `--cap-drop`; secure default drops everything                                |
| `capsAdd`     | `string[]`               | none      | Passed as repeated `--cap-add`; add back only what the workload needs                           |
| `workdir`     | `string`                 | none      | Passed as `-w`                                                                                  |
| `entrypoint`  | `string`                 | none      | Passed as `--entrypoint`                                                                        |
| `extraArgs`   | `string[]`               | none      | Verbatim flags appended before the image; escape hatch for options this schema doesn't yet name |

## Execution modes

The driver picks mode based on the request, same rule as swamp's built-in Docker driver:

- Request carries `bundle` (extension model method) — **bundle mode**. The driver mounts a temp dir with `bundle.js`, `request.json`, and a runner script into `/swamp/`, then runs `deno run --allow-all /swamp/runner.js` inside `bundleImage`. Runner writes `{ resources, files }` JSON to stdout; the host persists both.
- Request carries `methodArgs.run` (`command_shell`-style models) — **command mode**. The driver runs `sh -c "<run>"` inside `image`. Stdout becomes a single `stdout` resource; stderr streams as real-time logs via `callbacks.onLog`.

## Vault secrets

Vault sentinels (`${{ vault.get(...) }}`) are resolved by the host **before** the request reaches the driver. The microVM only sees plaintext values in `globalArgs` / `methodArgs` and in `env`. The container has no independent vault access.

## Hardening defaults

The schema defaults toward the secure end:

- `capsDrop: ["ALL"]` — drop every Linux capability by default. Add back only what the workload needs via `capsAdd`.
- `arch: "arm64"` — the native, fastest, and (currently) only fully-supported arch. Explicit opt-in for `amd64`.
- Every container starts with `--rm` — no persistent state between invocations.

## Not yet supported

- Memory swap control — the Apple CLI has no `--memory-swap` in v1.0.
- Detached / long-running containers — this driver is per-invocation only. Long-lived services still belong in a normal `swamp serve` or a systemd/launchd unit.
- Non-macOS hosts — `initialize()` fails fast with a clear message.

## Related

- Design doc: `design/execution-drivers.md` in the swamp source repo.
- Sibling first-class-driver proposal: [swamp-club Lab #939](https://swamp-club.com/lab/939) — asking swamp itself to ship `@apple/container` as a built-in driver next to `docker`. This extension is the shape that proposal would take.
