# Render Boundary (Control Plane vs Execution Plane)

> #450 — documented rule for where rendering code may live. Every renderer
> in this repo must belong to exactly one side; new renderers must follow
> the table below.

## The rule

- **Control plane (server-ts)**: decides WHAT to render and validates the
  content model. It NEVER runs document/office/PDF rendering.
- **Execution plane (worker + python-stats-worker)**: renders files
  (pptx/docx/pdf/table/plot) and computes authoritative statistics.

## Current layout

| Capability | Where it lives | Why |
|---|---|---|
| DOCX / PPTX / PDF / table / plot rendering | `packages/worker/src/handlers/` (job types `sidecar.{pluginId}.{tool}`) | Execution plane |
| BioScene SVG schematic (`render_scene`) | server-ts `tools/bioscene/` | Deterministic in-process vector drawing — no binary format |
| Charts (`render_chart`, `chart-renderer.ts`) | server-ts | Deterministic lightweight SVG, embeddable in chat via HMAC-token URL |
| Statistics (`run_stats_analysis`) | Strategy: python-stats-worker (scipy) when `STATS_WORKER_URL` is set, else TS stat-tools | #445 Strategy pattern |
| Report PDF (`report-pdf.service.ts`) | server-ts | Legacy report generation; accepted debt, tracked in #450 backlog |
| Academic figures (`render_figure`: mermaid / LaTeX → SVG, #825) | worker `handlers/figure.ts` (headless Chromium + local mermaid/MathJax bundles) | Non-deterministic JS rendering requires a DOM — never in server-ts; zero egress via local bundles + request interception |

## Boundary tests (add these when adding a renderer)

1. Is it a binary document format (.pptx/.docx/.pdf)? → worker.
2. Is it a deterministic vector drawing embedded inline? → server-ts (chart/scene only).
3. Does it need scipy/lifelines? → python-stats-worker via `StatsEngine`.
4. Does it need a DOM/browser (mermaid, MathJax, #825 figures)? → worker
   (`sidecar.render_figure`); server-ts must not import puppeteer/chromium.

## Anti-patterns (rejected)

- New `docx`/`pdfkit`/`pptxgenjs` imports in server-ts business modules.
- A third file-delivery mechanism for rendered files (all rendered files
  flow through `ExecutionPlaneService` → honest download URL).
- Parallel statistics implementations beyond the #445 Strategy (TS fallback
  is kept only until the golden cross-check locks the Python worker).
- A browser/`puppeteer-core` dependency in the control plane (#825 — all
  JS-class figure rendering lives in the worker's headless Chromium).
