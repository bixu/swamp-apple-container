# swamp-apple-container

Swamp extension repository providing [`@bixu/apple-container`](extensions/drivers/apple_container.README.md) — a swamp execution driver that runs each model method inside its own macOS Virtualization-framework microVM via Apple's `container` CLI.

## Why

Docker on macOS shares one Linux kernel across every container. Apple's `container` gives each container its own microVM. For agentic / LLM-driven / untrusted-code workloads, that's the isolation posture you want by default.

## Install

```
swamp extension pull @bixu/apple-container --channel beta
```

Then opt in via `.swamp.yaml` or per workflow/job/step/model:

```yaml
defaultDriver: "@bixu/apple-container"
defaultDriverConfig:
  image: docker.io/library/alpine:latest
  bundleImage: docker.io/denoland/deno:alpine
  cpus: "2"
  memory: "1g"
  capsDrop: ["ALL"]
  uid: 1000
  gid: 1000
```

Full reference: [`extensions/drivers/apple_container.README.md`](extensions/drivers/apple_container.README.md).

## Requirements

- macOS 15 (Sequoia) or later on Apple Silicon
- `/usr/local/bin/container` (Apple's container CLI 1.0+)
- Any container image with Deno available for bundle-mode

## Layout

```
extensions/drivers/
  apple_container.ts              — driver body
  apple_container_test.ts         — driver-level tests + smoke-test scaffold
  apple_container.manifest.yaml   — extension manifest
  apple_container.README.md       — user-facing docs
  _lib/
    cli.ts                        — pure flag-translation helpers
    cli_test.ts                   — unit tests, run everywhere
```

## Development

```bash
deno fmt --check extensions/
deno lint extensions/
deno test --allow-read --allow-write --allow-run --allow-env extensions/drivers/

# macOS smoke test — needs Apple's container CLI + macOS 15+
SWAMP_APPLE_CONTAINER_SMOKE=1 deno test --allow-all extensions/drivers/apple_container_test.ts
```

## Publishing

CI publishes automatically:

- Every PR against `main` publishes the changed manifests to the **beta** channel under `YYYY.MM.DD.<gha-run>`.
- Merges to `main` publish to the **stable** channel with the same version scheme.

See `.github/workflows/publish.yaml`. Manual publish is not intended.

## Related

- [swamp-club Lab #939](https://swamp-club.com/lab/939) — proposal to ship `@apple/container` as a first-class built-in driver alongside `docker`. This extension is the shape that proposal would take.
- [swamp execution driver design doc](https://github.com/swamp-club/swamp/blob/main/design/execution-drivers.md)

## License

MIT. See [LICENSE](LICENSE).
