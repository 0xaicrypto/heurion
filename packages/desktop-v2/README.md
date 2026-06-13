# nexus-desktop-v2

Next-generation Nexus desktop. Tauri 2.0 + React 18 + TypeScript + Tailwind + Radix.
Supersedes `packages/desktop/` (Avalonia 11) — see `docs/design/nexus-architecture.md`
and `docs/adr/ADR-002-m3-memory-merge.md`.

## What's in U0 (now closed)

- **Tauri 2.0 shell** — Rust + system WebView (WebKit on macOS, WebView2 on
  Windows). Single tiny window pre-coloured to the dark theme so there is no
  white-flash on launch.
- **Vite + React 18 + TypeScript** frontend with HMR. Strict TS settings.
- **Tailwind + design tokens** from `docs/design/nexus-architecture.md` §4 —
  warm-neutral palette, Google blue accent, Tiempos/system/JetBrains Mono
  type stack. Dark mode default, light mode supported via `.dark` class on
  `<html>`.
- **8 UI primitives** (`Button`, `Card`, `Section`, `Chip`, `Input`,
  `StatusDot`, `EmptyState`, `CitationChip`) in `src/components/ui.tsx`.
- **Shell layout** (`GlobalHeader`, `PatientsSidebar`, `ModeTabs`,
  `ContextRail`) in `src/components/layout.tsx`.
- **Overlay components** (`CommandPalette`, `NewPatientDialog`,
  `AccountMenu`, `ToastStrip`) in `src/components/overlays.tsx` —
  Radix-backed, accessible.
- **Login flow** (`src/login.tsx`) wired against the backend's
  `/api/v1/auth/login`. Falls back to a dev-mock token when the server
  isn't reachable.
- **Global state** (`src/store.ts`) — Zustand, with auth + theme +
  dialog open/closed + toast queue. Hydrates token + theme from
  `localStorage` on boot so there's no flash of LoginView when the
  user is already signed in.
- **Keyboard shortcuts** — `⌘K` command palette, `⌘.` context rail,
  `⌘B` sidebar collapse, `⌘N` new patient, `Esc` close overlays.
  Wired through `src/lib/keyboard.ts`.
- **Seven canvas modes** — `Today`, `Patient`, `Encounter` built out
  with mock data; `Imaging`, `Labs`, `Memory`, `Report` are stubs that
  describe what ships in U2/U3.
- **Mock patient data** in `src/lib/util.ts` — replaced by `ApiClient`
  HTTP calls in U1.
- **Dev proxy** `/api/v1/*` → `http://localhost:8001` (the FastAPI backend).

## Prerequisites

Install on your Mac:

```bash
# Rust toolchain (for Tauri's Rust shell)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# pnpm
npm install -g pnpm

# macOS build prerequisites
xcode-select --install
```

## First-run

```bash
cd packages/desktop-v2
pnpm install

# Generate placeholder app icons from the SVG source.
# (Required before tauri:build; tauri:dev tolerates missing icons.)
pnpm icons

# Start the desktop app — opens a window in ~2 s after first Rust compile.
pnpm tauri:dev
```

If the backend isn't running you'll see the login form. Click **"Continue
without server (dev / mock mode)"** to get into the app with mock data.

If the backend *is* running on `localhost:8001`, log in normally — the
proxy in `vite.config.ts` forwards `/api/v1/*` to it.

## Common workflows

```bash
pnpm dev           # frontend only (no Tauri shell), http://localhost:1420
pnpm typecheck     # tsc --noEmit
pnpm lint          # eslint
pnpm format        # prettier --write
pnpm icons         # regenerate Tauri icons from src-tauri/icons/source.svg
pnpm tauri:build   # signed installers in src-tauri/target/release/bundle/
```

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘K` | Open command palette (search patients, jump to mode, run action) |
| `⌘.` | Toggle context rail |
| `⌘B` | Collapse / expand patients sidebar |
| `⌘N` | New patient dialog |
| `Esc` | Close any open overlay |
| `↑/↓` (in palette) | Navigate results |
| `Enter` (in palette) | Run selected action |

## Project structure

```
packages/desktop-v2/
├── src/
│   ├── main.tsx                 entry (hydrates token + theme, then renders)
│   ├── App.tsx                  routes Login ↔ MainShell, wires shortcuts
│   ├── login.tsx                LoginView (centred form + dev-mode bypass)
│   ├── index.css                Tailwind + CSS variables (design tokens)
│   ├── store.ts                 Zustand global state
│   ├── modes.tsx                Today / Patient / Encounter / 4 stubs
│   ├── lib/
│   │   ├── util.ts              cn helper, types, mock data
│   │   ├── api-client.ts        HTTP wrapper around FastAPI backend
│   │   └── keyboard.ts          useGlobalShortcuts hook
│   └── components/
│       ├── ui.tsx               8 primitives
│       ├── layout.tsx           header / sidebar / mode tabs / context rail
│       └── overlays.tsx         palette / dialog / account menu / toast
├── src-tauri/
│   ├── Cargo.toml
│   ├── build.rs
│   ├── tauri.conf.json
│   ├── capabilities/default.json
│   ├── icons/
│   │   └── source.svg           regenerate PNG/ICNS/ICO with `pnpm icons`
│   └── src/
│       ├── main.rs
│       └── lib.rs
├── index.html
├── package.json
├── tsconfig.json
├── tailwind.config.ts
├── postcss.config.cjs
├── vite.config.ts
├── .eslintrc.cjs
├── .prettierrc.json
└── .prettierignore
```

## What's not in U0 (deferred to U1+)

- **U1**: real backend wiring (auth → token → patients list → studies →
  streaming chat over SSE), replace mock data, secure token storage via
  `@tauri-apps/plugin-stronghold`.
- **U2**: DICOM viewer in Imaging mode (cornerstone.js + OHIF Viewer
  components).
- **U3**: Labs (recharts), Memory (graph projection + conflict UI),
  Report export (PDF / FHIR / DICOM SR).
- **U4**: macOS notarisation, Windows code signing, auto-update flow.

## Design references

- `docs/design/nexus-architecture.md` — the design proposal this app implements
- `docs/design/m3-memory-architecture.md` v3 — memory layer behind the Memory mode
- `docs/adr/ADR-002-m3-memory-merge.md` — memory architecture decision

## Troubleshooting

**"icons/icon.icns not found" during `tauri:build`** — run `pnpm icons`
first to generate from `src-tauri/icons/source.svg`.

**"Cannot reach server" on login** — backend isn't running. Either start
the FastAPI server on 8001, or click "Continue without server" for
dev / mock mode.

**Dark mode flash on launch** — the `<html class="dark">` in `index.html`
plus the `backgroundColor` in `tauri.conf.json` should prevent this. If
you still see a flash, check that you're not running with `--debug` (which
disables the splash).

**HMR not updating Rust code** — Rust is recompiled on `tauri:dev`
restart, not on save. Restart the dev command after Rust changes.

## License

Same as the parent repository.
