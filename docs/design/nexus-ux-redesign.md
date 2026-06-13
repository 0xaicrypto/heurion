# Nexus UX/UI redesign — clinical workflow, Claude Desktop aesthetic, framework re-pick

**Status:** Design proposal (pre-ADR)
**Date:** 2026-06-13
**Owner:** JZ
**Related:** #196, current Avalonia codebase under `packages/desktop/RuneDesktop.UI/`
**Companion:** ADR-002 (memory architecture) — this redesign assumes graph-backed memory is the substrate

---

## 1. Why redo it

The current desktop is built on Avalonia 11.3 / .NET 10. It carries three kinds of debt we can no longer absorb cheaply:

**Framework friction.** AVLN2000 errors on perfectly reasonable XAML (`Run.IsVisible` not supported on inline text — #189), cross-DataContext type cast failures at the runtime resolver (#184 crash), CornerRadius resource definitions silently breaking at runtime, DataContext duplicate creation bugs that ate two sessions to find (#188). Every UI change risks a XAML quirk; the platform is fighting us instead of helping.

**Wrong information architecture for medics.** The screen today is roughly "session-rail + main-canvas + brain-panel" — a structure inherited from the generic personal-agent prototype. A radiologist's day is not "many sessions about whatever"; it's "this patient, that study, these labs, what did we conclude". The current rail was retrofitted in #174 from sessions → patients but the rest of the surface (Plan view, Library view, Brain/Cognition/Pressure panels, Files view) is still organised around the agent's own internals, not the medic's tasks.

**Visual language mismatch.** Indigo/cyan accents, dense card chrome, heavy buttons — none of it fits a clinical setting where the medic stares at the screen for 10-hour shifts. The login page already proves the direction: warm, restrained, typography-driven. The rest of the app hasn't caught up.

The proposal: **rebuild the surface around clinical primitives, adopt a Claude Desktop-style visual language, and switch off Avalonia.**

---

## 2. Who we're designing for

Three primary personas. The redesign optimises for #1 and #2; #3 is accommodated, not centred.

**Radiologist (primary).** Reads 50–80 studies per shift. Spends most of the day inside a DICOM viewer, dictating findings. The agent's job is to surface prior comparisons, prior findings on the same body region, and to draft the structured report. Hates anything that costs more than two clicks to dismiss.

**Hospitalist (primary).** Carries 12–20 inpatients. Switches contexts dozens of times per shift. Needs "what changed since last round" answers in <10 s. Lives in chat + lab trends, dips into imaging only when the radiologist's read is back.

**Resident / fellow (secondary).** Same workflows as above but uses the agent more aggressively for teaching ("explain this differential", "what would an attending ask next"). Tolerates more chrome and more options than the senior personas.

The hostile reader to design against: a sleep-deprived senior at 03:00 who can't find the prior CT because the rail collapsed a category on its own.

---

## 3. Design principles

These six govern every screen decision below.

**Calm by default.** No motion that isn't communicating state. No accent colour without semantic meaning. Whitespace is load-bearing, not "leftover". The screen at rest looks like a document, not a dashboard.

**Patient is the root noun.** Every screen answers "what about this patient" first, "what about this study/encounter/lab" second. Navigation is patient-anchored; nothing makes you remember a session id.

**Every claim is citable, every action is reversible.** If the agent says "BI-RADS 4" the source — study + slice + the model's reasoning — is one click away. If the medic accepts that into the report, undo is one click away. This is non-negotiable for medico-legal use.

**Dual density.** Conversational screens (chat, today briefing) follow Claude Desktop's airy single-column layout. Clinical screens (imaging viewer, lab trends, study comparison) get higher density because the medic explicitly demands it. The visual language is shared; the spacing scale changes.

**Keyboard-first for the senior persona.** Every action that a radiologist does more than 5 times per shift has a key binding. Mouse is fine for residents and edge cases.

**One canvas, multiple modes — not many windows.** Floating side-panels, popups, modal stacks, brain-panel docks are how the current app accumulated complexity. Replace with a single main canvas that swaps mode, plus a single right-rail context surface.

---

## 4. Visual language

Aligned with Claude Desktop, adapted for clinical density.

**Palette (light mode).** Background `#F7F4EE` (warm paper). Surface `#FFFFFF`. Text primary `#2D2A26`. Text secondary `#6B6660`. Border subtle `#E8E2D8`. Accent — the Google blue `#1A73E8` we already aligned to in #189; semantic colours muted (`#B45309` for caution amber, `#B91C1C` for retract red, `#15803D` for confirmed green). No purple, no teal, no gradients.

**Palette (dark mode, default).** Background `#1B1A18`. Surface `#252320`. Text primary `#EDE6D8`. Text secondary `#A09A8E`. Border subtle `#3A3631`. Same accents, slightly desaturated.

**Typography.** Headings: Tiempos Text or a serif fallback (`Charter`, `Georgia`) — the same family Claude Desktop uses. Body: system stack (`-apple-system`, `Segoe UI`, `Inter`). Numerics (labs, vitals): tabular-figured `JetBrains Mono` or the system mono. Two heading sizes only (display 28px, section 18px); body 14px; caption 12px. We resist the urge for an h1/h2/h3/h4/h5 zoo.

**Spacing scale.** 4 / 8 / 12 / 16 / 24 / 40 / 64. Conversation surfaces start at 24; clinical surfaces start at 12.

**Corner radius.** 8px small (chips, inputs), 12px medium (cards), 16px large (modals). No 24+; no perfect circles except avatars.

**Iconography.** Lucide-style line icons, 1.5px stroke. We do not introduce a custom icon system. Icons are paired with text labels for any action invoked less than 20×/day.

**Motion.** Crossfades and 150ms ease-out only. No spring physics, no slide-in panels. Hover transitions are 80ms.

---

## 5. Information architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         GLOBAL HEADER                            │
│  ◀▶  ⌘K Search          Nexus            ⊕ New patient    👤   │
└─────────────────────────────────────────────────────────────────┘
┌────────────┬─────────────────────────────────────┬──────────────┐
│            │                                     │              │
│            │                                     │              │
│  PATIENTS  │           MAIN CANVAS               │   CONTEXT    │
│   SIDEBAR  │     (one mode at a time)            │    RAIL      │
│            │                                     │  (optional)  │
│            │                                     │              │
│            │                                     │              │
└────────────┴─────────────────────────────────────┴──────────────┘
```

**Global header (48px).** Back/forward, command palette (⌘K — opens a Spotlight-like fuzzy search across patients, findings, studies, chats), brand mark, single primary action ⊕ New patient, account avatar. Nothing else. No tabs, no breadcrumbs (the sidebar handles that).

**Patients sidebar (260px, collapsible to 56px icon strip).** Two stacked sections: **PINNED** (today's roster — 5–20 patients the medic touched in the last 24h, surfaced by recency + AI nudges like "abnormal lab posted") and **ALL** (search-filtered alphabetical list). Each patient card shows: 12-char hash prefix or display name, demographics chip (F · 50–59), the most recent study modality (CT, MR, US) as a small mono chip, a status dot if there's an unread agent message or unresolved memory conflict. Click expands inline to show the patient's recent encounters; double-click navigates the main canvas to that patient.

This **replaces** the current PatientNavigator + SessionRail split. Sessions are not a navigational concept any more — they're an internal artifact, surfaced only inside an encounter view.

**Main canvas (flexible, 880px target).** One mode at a time. Mode is selected by tabs along the top of the canvas, not by left-rail toggling. Modes:

- **Today** (default, when no patient is selected)
- **Patient** (overview of one patient)
- **Encounter** (one chat session, threaded with the agent)
- **Imaging** (DICOM viewer)
- **Labs** (trend grid)
- **Memory** (graph-projection markdown + conflicts)
- **Report** (structured draft for export)

Mode is a soft URL — `nexus://patient/{hash}/imaging?study=...` — so deep linking and back/forward work.

**Context rail (320px, default closed).** Right-side, opens with ⌘. or click. Holds the agent's current scratchpad — what it just retrieved from memory, what cites support its current message, what tools it ran. **This is where citations live.** Clicking a citation in a chat message slides the rail open to show the source. Closing the rail is one ⌘. or click outside.

This **replaces** the current Brain/Cognition/Pressure panels — those were agent-internal debug surfaces; useful for development, not for the medic. They move to an Admin view, off the main flow.

---

## 6. The seven canvas modes

### 6.1 Today (default landing)

When no patient is selected the main canvas shows a single column, Claude Desktop-style.

```
                        Good morning, JZ
                  Saturday · June 13, 2026

┌─────────────────────────────────────────────────────┐
│  📋  3 unread findings since you signed off          │
│      Patient 7a3f… — CT abdomen, BI-RADS upgrade    │
│      Patient 9c12… — creatinine trending up         │
│      Patient bb04… — chest pain follow-up due       │
└─────────────────────────────────────────────────────┘

   Pinned today                              [edit]
   ─────────────────
   ◯ Patient 7a3f…    M · 60-69   CT
   ◯ Patient 9c12…    F · 45-54   labs
   ◯ Patient bb04…    M · 70-79   chat

   Ask Nexus about any patient
   ┌───────────────────────────────────────────────┐
   │  Type a question or paste an MRN…             │
   └───────────────────────────────────────────────┘
```

No dashboards, no widgets, no metrics. A short briefing the agent generated at sign-on, a list of pinned patients, and a single text input. The text input is the global agent — typing "creatinine for 9c12" is equivalent to opening 9c12 and asking it.

### 6.2 Patient overview

The default mode when a patient is selected. One column, document-flow.

```
   Patient 7a3f…    M · 60-69
   ────────────────────────────────────

   Summary  ·  generated 2 min ago         [refresh]

   This patient has been followed for 4 months for a
   left renal mass first noted on the index CT
   (2026-02-14). The mass measured 2.1 cm initially
   and 2.4 cm on the most recent follow-up CT
   (2026-06-10). DDx leans toward RCC; biopsy was
   discussed but deferred pending MR characterisation.

   Sources: study 1.2.840…7822 [index]   1.2.840…9104 [latest]

   ─────────────────────────────────────

   Timeline
   ┌─────────────────────────────────────────────┐
   │ Jun 10 · CT abdomen w/ contrast    →        │
   │ May 23 · Labs (CMP, CBC)           →        │
   │ Apr 02 · Chat: discussed MR option →        │
   │ Feb 14 · CT abdomen [INDEX]        →        │
   └─────────────────────────────────────────────┘

   ─────────────────────────────────────

   Active concerns                 Medications
   • Left renal mass               • Lisinopril 10 mg
   • Hypertension                  • Atorvastatin 20 mg

   Open with Nexus →
```

Every block is a section of the graph projected to markdown. Citations are inline; clicking opens the right rail with the source. "Open with Nexus" takes you to Encounter mode pre-loaded with this patient's context.

### 6.3 Encounter (chat with agent)

Pure Claude Desktop layout. Single column, message bubbles, input at bottom.

```
   Patient 7a3f… · CT comparison         [⌘. context]

   ─────────────────────────────────────

   You · 10:42
   compare the latest CT to the index. what changed?

   Nexus · 10:42
   The left renal mass measured 2.1 cm on the index
   CT (Feb 14) and 2.4 cm on the latest (Jun 10) — a
   0.3 cm interval increase over ~4 months, consistent
   with slow growth. Margins remain well-defined; no
   new enhancement pattern. [1] [2]

   Differential narrows toward RCC given growth and
   lack of regression. MR with contrast remains the
   recommended next step. [3]

       [1] study 1.2.840…7822 slice 142
       [2] study 1.2.840…9104 slice 138
       [3] memory: discussion with you on 2026-04-02

   You ·
   ┌─────────────────────────────────────────────┐
   │ Ask anything about this patient…        ⏎  │
   └─────────────────────────────────────────────┘
```

The citation chips `[1] [2]` are hover-revealable. Clicking opens the context rail with the source preview (study slice rendered, or chat snippet). The medic can pin a citation to the patient's record with a single hotkey (⌘+S on the focused chip).

The thinking pane from the current app (cognition panel) is **demoted** — only shown if the medic explicitly enables "show agent reasoning" in account settings. Default is off; senior medics don't want to see it.

### 6.4 Imaging

The one mode that breaks airy spacing. Density wins here because the medic is comparing studies.

```
┌─ Studies ─┬──────── Viewport ────────┬─ Findings ─┐
│ ● Jun 10  │                          │ Left renal │
│   CT abd  │                          │ mass 2.4cm │
│ ○ Feb 14  │      [DICOM slice]       │ Margins:  │
│   CT abd  │                          │ well-def. │
│ ○ Sep 22  │      slice 138 / 412     │ Enhance:  │
│   CT chest│                          │ heterogen.│
│           │  W: 400  L: 40           │           │
│           │                          │ — Nexus   │
│           │                          │ [draft]   │
└───────────┴──────────────────────────┴───────────┘
   tools: 📏 measure  ⊞ window  ◧ MPR  ▣ compare
```

Side-by-side study compare is a first-class affordance, not a hidden menu. The right column is the agent's draft findings; the medic accepts/edits inline. Keyboard: `↑↓` paginate slices, `W/L` adjust window/level, `M` measure, `Space` toggles compare-mode.

### 6.5 Labs

Density-mode, but documentary not spreadsheet.

```
   Trends · Patient 7a3f…           [3mo] [6mo] [1y]

   Creatinine          ────────╱────────  1.4 ↑
   eGFR                ────╲────────────  52  ↓
   K+                  ─────────────────  4.1 ─
   Hgb                 ─────────────────  13.2 ─

   ─────────────────────────────────────

   Recent values             Reference range
   Creatinine    1.4         0.7 – 1.3  ⚠
   eGFR          52          ≥60        ⚠
   K+            4.1         3.5 – 5.0
   Hgb           13.2        13 – 17

   Nexus note · 8 hr ago
   Creatinine rose 0.3 from baseline (0.9 → 1.4) over
   2 weeks. Lisinopril dose increase on May 28 is the
   most likely cause; trend is mild and reversible.
   Recommend recheck in 1 week. [source: lab id 8294]
```

Sparklines are minimum-chrome. The "Nexus note" is a graph projection — every numeric claim cites the lab id.

### 6.6 Memory

The patient's graph projected to markdown, plus a conflict panel.

```
   Memory · Patient 7a3f…

   ─────────────────────────────────────

   ▼ Active findings
     • Left renal mass — first seen 2026-02-14,
       growing slowly (2.1 → 2.4 cm)
     • Hypertension — controlled on lisinopril

   ▼ Medications
     • Lisinopril 10 mg daily (since 2026-01-04)
     • Atorvastatin 20 mg daily (since 2026-01-04)

   ▼ Allergies / contraindications
     • Iodine contrast — mild reaction 2024

   ▼ Plan / open threads
     • MR with contrast — discussed 04-02, not yet
       scheduled

   ─────────────────────────────────────

   ⚠ 1 unresolved conflict

   ┌───────────────────────────────────────────────┐
   │ Left renal mass — size                        │
   │                                                │
   │ Ⓐ 2.4 cm    from CT Jun 10  [latest, weight 4]│
   │ Ⓑ 2.1 cm    from CT Feb 14  [older, weight 2] │
   │                                                │
   │ Nexus picked Ⓐ. Override?                     │
   │      [keep Ⓐ]  [pick Ⓑ]  [both are wrong]    │
   └───────────────────────────────────────────────┘
```

Conflicts are surfaced explicitly — the dialog from §7 of the memory design doc lives here.

### 6.7a Settings → Data (Backup & Export)

This is the UI surface of ADR-002 Rev-7 / memory-design §16 — the medic's view of the four-layer persistence + sovereign export contract. Not a "mode" in the canvas-tab sense; lives inside the Account menu (avatar → Settings → Data tab), opening as an inline panel within the Patient sidebar's place when invoked.

```
   Settings · Data
   ───────────────────────────────────

   Your data is yours. The export format is open
   and documented. Nexus going away does not take
   your records with it. → docs.nexus.dev/export-format

   ───────────────────────────────────

   Automatic backups            local · always on

   ┌─────────────────────────────────────────────┐
   │ Last snapshot     2026-06-13 06:00 · 8h ago │
   │ Storage used      1.8 GB                    │
   │ Retention         30 daily · 12 weekly ·    │
   │                   24 monthly                │
   │                                              │
   │ [ Open Archive folder ]                     │
   │ [ Configure retention… ]                    │
   └─────────────────────────────────────────────┘

   Cloud sync                          optional

   ┌─────────────────────────────────────────────┐
   │ ◯ Not configured                            │
   │                                              │
   │ Sync your encrypted archives to iCloud      │
   │ Drive, Google Drive, OneDrive, or S3.       │
   │ Encryption keys stay in your macOS Keychain.│
   │                                              │
   │ [ Set up cloud sync… ]                      │
   └─────────────────────────────────────────────┘

   Export all my data

   ┌─────────────────────────────────────────────┐
   │ Last full export    never                   │
   │ Estimated size      2.1 GB                  │
   │ Includes            7 patients              │
   │                     4 months of practitioner│
   │                       memory                 │
   │                     complete event log       │
   │                     all prompts + configs    │
   │                                              │
   │ [ Export now… ]   [ Schedule monthly… ]     │
   └─────────────────────────────────────────────┘

   Restore from backup

   [ Restore local snapshot… ]
   [ Import from archive bundle… ]
```

Six implementation details for the front-end engineer:

The trailing italic paragraph is **literal user-facing surface text**, not marketing copy — it is the visible manifestation of Contract A. The link below it (`docs.nexus.dev/export-format`) goes to public documentation describing the bundle format and how to read it without Nexus. **This text and link must never be deleted or buried**. Code review checklist item.

`[ Open Archive folder ]` invokes Tauri's `tauri-plugin-shell` to open `~/Documents/Nexus Archive/` in Finder. No additional permission needed.

`[ Export now… ]` opens a multi-step wizard (`ExportWizardDialog`, new Radix Dialog) with three stages: (1) choose scope (all data / select patients), (2) **PHI-in-transit warning** with explicit attestation checkbox + age-encryption offer (default ON), (3) destination chooser (save to `~/Documents/Nexus Archive/exports/` or attach to message). The wizard surfaces the R20 risk visibly — no silent exports of unencrypted PHI.

`[ Schedule monthly… ]` opens a sub-dialog that lets the medic configure a recurring background export — `crontab`-style schedule (default: first of every month at 03:00 local) + destination. Stored as a `scheduled_export` row in the local config table.

`[ Restore local snapshot… ]` opens a snapshot picker (list of available snapshots with date / size / patient count). Selecting one shows a destructive-action confirmation modal: **"This will replace your current data with the snapshot from <date>. Your current data will be saved as a recovery snapshot first."** Then performs the destructive restore, having first snapshotted the current state per R19 mitigation.

`[ Import from archive bundle… ]` opens a file picker scoped to `.tar.zst` / `.zip` archive bundles. Validates `MANIFEST.json` schema version and offers a migration preview if the bundle is from an older Nexus version.

Component additions required:
- `SettingsView.tsx` — new top-level view (lives in `src/modes.tsx` or a parallel `src/settings.tsx`); reachable via `AccountMenu → Settings`.
- `BackupCard.tsx`, `CloudSyncCard.tsx`, `ExportCard.tsx`, `RestoreCard.tsx` — four cards in the Data tab.
- `ExportWizardDialog.tsx` — Radix Dialog, multi-step.
- `RestoreConfirmDialog.tsx` — Radix Dialog with destructive-action styling.
- `useBackupStatus()` hook — polls `/api/v1/data/backup-status` every 30s while Settings is open.
- API client additions: `getBackupStatus()`, `triggerExport(opts)`, `getCloudSyncConfig()`, `listSnapshots()`, `restoreSnapshot(id)`, `importBundle(path)`.

### 6.7 Report (structured export)

The medic's destination at end of an encounter. A structured form the agent pre-fills from the graph; the medic edits; export goes to PDF / FHIR / DICOM SR.

```
   Findings draft · 7a3f… · CT abd Jun 10

   IMPRESSION
   ┌───────────────────────────────────────────────┐
   │ 1. Left renal mass, 2.4 cm, mildly enlarging  │
   │    from prior. RCC remains top differential.  │
   │    Recommend MR with contrast.                │
   │                                                │
   │ 2. No new findings in the contralateral kidney│
   │    or adrenals.                                │
   └───────────────────────────────────────────────┘
                                       [accept] [edit]

   COMPARISON   CT abd Feb 14 (4 months prior)
   TECHNIQUE    Contrast-enhanced…
   FINDINGS     …

   [Export PDF]  [Export FHIR]  [Save to chart]
```

Nothing is sent anywhere without an explicit medic action. Every section is editable; every section traces back to a source via the rail.

---

## 7. Component vocabulary

A small set of primitives composes every screen. Naming them up front prevents the "30 button variants" problem the current app accumulated.

**Card.** White surface, 12px radius, 1px subtle border, 16px padding. Used for patient list items, timeline rows, finding chips. No shadows.

**Section.** A heading + horizontal rule + content. Replaces what current app calls "panel". No box around it — just typography hierarchy.

**Chip.** 8px radius, 4px/8px padding, mono small. Demographics, modalities, weights, citation indices. Two variants: neutral (border only) and tinted (subtle background for status).

**Button** — three variants only.
- **Primary** — accent fill, white text, 13px padding, used at most once per screen.
- **Subtle** — transparent, border, used for secondary actions.
- **Ghost** — no border, hover background, used for tertiary actions in tight UI (toolbar icons).

**Input** — single visual: 8px radius, 1px border, focus ring matches accent. No "floating label" or "outlined v3" variants.

**Citation chip.** Inline `[N]` superscript-style. Hover reveals tooltip with source meta; click opens context rail.

**Status dot.** 8px circle, three colours only (unread blue, caution amber, alert red). Hover for tooltip.

**Empty state.** Center-aligned text + single subtle CTA. No illustrations.

**Dialog.** 16px radius modal. One title, one body, two buttons max. No nested modals — ever.

That's the entire vocabulary. Compare to the current app's accumulation of 12 button classes, 6 panel variants, custom converters for fills and histogram heights.

---

## 8. Framework re-pick

The current pain is real and recurring. Three candidates evaluated.

### 8.1 Stay on Avalonia 11.x

| Dimension | Assessment |
|---|---|
| Familiarity | We know it. Working code exists. |
| Design fidelity | Possible but expensive. Matching Claude Desktop's typographic feel in XAML means custom font loading, manual radius/spacing tokens, fighting the default theme. |
| DICOM viewing | No first-class library. We'd wrap fo-dicom for parsing and render slices to bitmap — works but is months of work. |
| Iteration speed | Slow. Every XAML change risks AVLN errors; hot reload is partial. Six bugs in the last two weeks were XAML-runtime quirks. |
| Cost of switch | Zero. |
| Verdict | **Reject** unless the team grows. Solo developer can't afford the friction. |

### 8.2 Flutter Desktop

| Dimension | Assessment |
|---|---|
| Familiarity | New language (Dart). 1–2 week onboarding. |
| Design fidelity | Excellent. Skia rendering = pixel control. Cupertino + Material packages give us a clean base. |
| DICOM viewing | Weak. `dicom` package on pub.dev exists but is alpha; no equivalent of cornerstone.js. Custom rendering required — months. |
| Iteration speed | Excellent. Stateful hot reload. Single codebase desktop + mobile (future iPad app — free option). |
| Native integration | Channels for platform code; FFI for native libs. Workable but adds an IPC layer. |
| Cost of switch | High. Full UI rewrite. Service layer (ApiClient HTTP) re-implements in Dart trivially. |
| Verdict | **Strong candidate** if we want a future mobile path. Killer is DICOM. |

### 8.3 Tauri 2.0 + React/TypeScript (recommended)

| Dimension | Assessment |
|---|---|
| Familiarity | Web stack — universally familiar; TypeScript is our team's strongest tooling. |
| Design fidelity | **Best** — Claude Desktop is itself a web-tech app. Matching its look is a CSS port, not a re-derivation. Tailwind + Radix UI gives us the primitives. |
| DICOM viewing | **Best.** Cornerstone.js + OHIF-derived components are the industry standard for browser DICOM. Years of radiology-domain tuning. |
| Iteration speed | Best. Vite HMR. Storybook for components. |
| Binary size | ~5 MB Tauri shell vs ~50 MB Electron vs ~30 MB Avalonia self-contained. |
| Memory footprint | Tauri uses the system WebView (WebKit on macOS, WebView2 on Windows) — single process, ~80–120 MB resident vs Electron's 300+ MB. |
| Backend integration | Tauri's Rust core can either talk to our existing FastAPI over HTTP (zero backend change) or replace `RuneDesktop.Core` services with Rust commands (later refactor). |
| Native APIs | Tauri 2.0 ships file system, notifications, secure storage, deep links, IPC. Auto-update built in. macOS / Windows / Linux all stable; iOS/Android are beta (future option). |
| Security model | Allowlist-based — only the IPC commands we expose are callable from the frontend. Stricter than Electron's IPC. |
| Cost of switch | Medium. UI rewrite in React/TS. ApiClient port from C# to TS is mechanical. Login/auth flow has to be re-ported (~3 days). |
| Verdict | **Recommend.** Best fit for our actual constraints: solo developer, Claude Desktop aesthetic target, DICOM as a hard requirement, future mobile path optional. |

### 8.4 Why Tauri beats Flutter for us specifically

Three reasons.

DICOM. Cornerstone.js + OHIF Viewer libraries are what every commercial radiology workstation in the browser is built on. We'd be reusing 10+ years of domain work. Flutter would have us writing slice rendering from scratch.

Claude Desktop matching. The thing we explicitly want our app to look like is itself rendered in a web view. CSS variables, Tailwind tokens, Radix accessibility primitives — same toolchain. We can almost copy-paste design tokens.

Cost of being wrong. If Tauri turns out limiting in 12 months, the React UI is portable to Electron, to a web app, even to a native iOS app via React Native. If Flutter turns out wrong, we rewrite. Web tech is the lowest-lock-in option available.

### 8.5 What we keep, what we throw away

**Keep:**
- `packages/server/nexus_server/` — FastAPI backend. Frontend rewrite doesn't touch it.
- Service contracts (REST endpoints under `/api/v1/`). React app calls them over HTTP via a thin `nexus-api` TypeScript client.
- Auth flow (JWT bearer). Re-implement in TS using `@tauri-apps/plugin-stronghold` for token storage.
- Quick scan, ingestion, memory layer — all server-side, untouched.

**Throw away (move to deprecated/ for a release):**
- `packages/desktop/RuneDesktop.UI/` — entire Avalonia project.
- `RuneDesktop.Core` services — port semantic contract to TS interfaces; reimplement bodies (mostly HTTP calls anyway).
- Existing converters, value parsers, XAML-specific glue.

**New:**
- `packages/desktop-v2/` — Tauri 2.0 project. Vite + React 18 + TypeScript. Tailwind for styling, Radix for primitives, cornerstone.js for DICOM, recharts for lab trends.

---

## 9. Migration plan

Five phases, each independently shippable, each ~1 week for a solo dev.

**Phase U0 — Scaffold (1 week).** `pnpm create tauri-app` for `packages/desktop-v2/`. Set up Vite, Tailwind, Radix, ESLint. Port the ApiClient skeleton (auth + base fetch). Build the global header + patients sidebar with mock data. Exit: app launches, can sign in, shows mocked patient list.

**Phase U1 — Today + Patient + Encounter (1 week).** Wire up real `/api/v1/dicom/patients`, `/api/v1/patients/{hash}/...`. Build Today briefing, Patient overview, Encounter chat modes. Streaming chat over SSE or WebSocket. Exit: parity with current chat experience on these three modes.

**Phase U2 — Imaging (1.5 weeks).** Integrate cornerstone.js + OHIF Viewer components. Build the three-column imaging mode. Side-by-side compare. Keyboard shortcuts. Exit: a radiologist can scroll a CT, measure, compare two studies.

**Phase U3 — Labs + Memory + Report + Settings/Data (2 weeks).** Build the remaining three canvas modes. Memory mode wires into the ClinicalGraph from ADR-002. Report export pipeline. **Plus** the Settings → Data panel from §6.7a (Backup & Export cards + ExportWizardDialog + RestoreConfirmDialog), wired to the backend persistence endpoints from memory-design §16.9 (D1/D2 work — `getBackupStatus`, `listSnapshots`, `triggerExport`, `importBundle`). The frontend lands in U3 to match the backend's D1/D2 ship timing after M5. Exit: feature parity + new modes + medic can run a full export and restore.

**Phase U4 — Cutover (0.5 week).** New app becomes the only signed installer. Old Avalonia stays in `deprecated/` for one release as a rollback. Bug-bash + a/b period.

Total: ~5 dev-weeks for the front-end migration. Backend untouched.

Risk reduction: U0 produces a runnable shell with the new IA before any clinical feature is ported. If the framework choice is going to bite, we find out in week one, not month three.

---

## 10. What the user sees on day one (after U1)

A working app that:

- Launches in <500ms (vs current ~2s Avalonia cold start).
- Looks visibly closer to Claude Desktop than to the current indigo-card app.
- Has a single sidebar with patients (not sessions, not "library", not "files", not "plan").
- Lets the medic ⌘K-search across patients, findings, and chats.
- Renders chat with citation chips that open the source on click.
- Defaults to dark mode (medic preference, per existing user feedback).

And under the hood:

- One backend codebase, unchanged. Same FastAPI, same SQLite, same memory layer.
- 1/6 the binary size, 1/3 the memory.
- Hot reload turnaround measured in milliseconds, not seconds.

---

## 11. Risks & mitigations

**R1 — DICOM perf in a WebView.** Cornerstone.js + WebGL rendering should match native, but multi-frame CT cines could stutter on older hardware.
Mitigation: benchmark in U2; fall back to canvas-only rendering for low-end machines; consider WebGPU when stable in WebView.

**R2 — Lose existing user base on cutover.** Anyone running the Avalonia .dmg has to download the new build.
Mitigation: keep auto-updater pointing both old + new at the same backend; old app keeps working until U4 cutover; in-app banner announcing the switch.

**R3 — Web stack security in clinical context.** Web tech historically less secure than native; PHI risk.
Mitigation: Tauri's allowlist + CSP, no remote URLs in WebView, all PHI stays server-side and PHI-hashed on the wire (existing #162 contract), no PHI in localStorage.

**R4 — Apple notarisation + Windows signing complexity.** Tauri's build pipeline is newer than Avalonia's; signing recipes still evolving in v2.
Mitigation: validate signing pipeline in U0, before any feature work — a one-day spike confirms macOS + Windows installers.

**R5 — Solo dev unfamiliar with cornerstone.js.** It's the most domain-specific dep in the new stack.
Mitigation: U2 starts with a 2-day spike using OHIF Viewer's stock components; only then build the custom three-column shell on top.

**R6 — Lose Avalonia code as a fallback during the rewrite.** During U0–U3 we have two desktop apps.
Mitigation: freeze Avalonia feature work at start of U0 (only critical bug fixes). All new clinical features ship only in v2.

---

## 12. Open questions

1. **iPad rounds-mode?** Tauri 2.0 has iOS in beta. If the hospitalist persona wants a tablet for bedside, this becomes a major bonus of the framework switch. Defer decision to after U2.
2. **Voice dictation in Imaging mode?** Radiologists dictate everything. Web Speech API + server-side Whisper would slot in cleanly. Not in U0–U4 scope; flag for a U5.
3. **Cross-medic shared graphs?** Out of scope per ADR-002, but the UI sidebar would need a "shared with me" section. Don't design for it now; leave architectural space.
4. **Plugin/extension model?** Tauri supports it well, Avalonia doesn't. Could be a 12-month strategic differentiator (medics building their own templates / report styles).

---

## 13. References

- Current Avalonia UI: `packages/desktop/RuneDesktop.UI/`
- ADR-002 (memory) — the substrate this UI sits on
- Claude Desktop visual language (proprietary; analysed by inspection)
- Tauri 2.0 release notes: <https://v2.tauri.app>
- Cornerstone.js: <https://www.cornerstonejs.org>
- OHIF Viewer: <https://ohif.org>
- Radix UI primitives: <https://www.radix-ui.com>
- #189 (button + accent alignment with login page) — first step in this direction
- #174 (sessions → patients rail rework) — confirmed the IA shift was needed
