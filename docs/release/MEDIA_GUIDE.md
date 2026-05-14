# Screenshots And Demo Video

Use this guide when preparing release assets, README images, or launch posts.

## Current Screenshot Assets

The following masked `ms_aks_stage` screenshots are ready for docs and release
drafting:

- `docs/assets/screenshots/lumen-ms-aks-stage-workloads-masked.png`
- `docs/assets/screenshots/lumen-ms-aks-stage-nodes-masked.png`
- `docs/assets/screenshots/lumen-ms-aks-stage-metrics-masked.png`
- `docs/assets/screenshots/lumen-ms-aks-stage-security-masked.png`
- `docs/assets/screenshots/lumen-ms-aks-stage-cloudmap-masked.png`

They intentionally mask resource names, table contents, graph nodes, and other
cluster-specific operational details.

## Screenshot Checklist

Capture:

- Fleet view with multiple contexts when possible.
- Workloads list with filters visible.
- Resource detail drawer showing metadata, events, and redacted YAML.
- Logs view with search and pause controls.
- Helm or Argo CD view if it is part of the release highlight.
- Settings or security view when documenting local-first behavior.

Do not capture:

- Real kubeconfig contents.
- Tokens, Secret values, private cluster names, or customer data.
- Internal planning files or local-only automation artifacts.

## Local Fixture Cluster

Use the fixture cluster for clean public screenshots:

```bash
./scripts/kind-fixture.sh
npm run dev
npm run tauri dev
```

Select context `kind-lumen-dev` and namespace `lumen-demo`.

## Browser Screenshots

For web-mode screenshots, run:

```bash
npm run dev
```

Then capture with Playwright or the Codex browser tooling. Store generated
images under `docs/assets/screenshots/`.

## Desktop Screenshots

For desktop screenshots, run:

```bash
npm run tauri dev
```

Then use the macOS screenshot tool or Codex Computer Use to capture the Lumen
window. Prefer 1440 x 900 or 1600 x 1000 images.

## Demo Video Outline

Keep the release demo under 90 seconds:

1. Open Lumen and select a cluster.
2. Search workloads and open a resource detail drawer.
3. Show redacted Secret YAML or a non-sensitive YAML view.
4. Stream logs and use search.
5. Start a safe read-only workflow such as events, rollout timeline, or Helm
   release details.
6. End on the local-first/security message.

## Recording Commands

On macOS, QuickTime is the simplest manual option. For scripted browser-mode
captures, use Playwright video recording or a screen recorder such as `ffmpeg`
when installed.

Recommended output location:

```text
docs/assets/video/
```

Keep source videos out of commits if they are large. Commit optimized clips only
when they are intentionally part of the public docs.
