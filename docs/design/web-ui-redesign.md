# Web UI Redesign — from desktop-v2 to browser-first SaaS

**Status:** Design proposal  
**Date:** 2026-07-15  
**Scope:** Replace `packages/desktop-v2` with `packages/web` as the canonical Nexus UI.

---

## 1. What we learned from desktop-v2

`packages/desktop-v2` is a Tauri 2 + React clinical agent UI. It has a deep feature set but carries desktop-era assumptions and accumulated inconsistencies. The full feature inventory is in the migration analysis; below are the facts that most influence the redesign.

### 1.1 Core user workflows

1. **Patient work** — pick a patient from the sidebar, then move through modes: summary, chat encounter, imaging, labs, memory/report.
2. **Research work** — switch to a separate full-screen research workspace with its own study list and tabs.
3. **Writing** — co-write documents in a dedicated editor with an inline chat panel.
4. **Admin/ops** — user management, data export/archive, LLM settings, learned-fact review.

### 1.2 Pain points to fix in the redesign

| Pain point | Why it hurts | How the redesign fixes it |
|---|---|---|
| Two visual systems (`base-*` and `rw-*`) | Research/writing workspace feels like a different app. | Single unified design system with one palette and consistent components. |
| Four chat UIs with different bubbles, composers, and error styles | Cognitive load; maintenance burden. | One `MessageBubble` + `ChatComposer` used everywhere. |
| Composer drafts/attachments lost on mode switch | Clinical users context-switch constantly. | Global draft store keyed by session; persists across navigation. |
| Tauri-only shell and sidecar assumptions | Blocks browser deployment. | Remove Tauri; backend runs remotely or self-hosted; cookie-based auth. |
| Token passed in URL for DICOM viewer | Security risk and browser-incompatible. | Serve OHIF/Cornerstone viewer from same origin so cookies authenticate. |
| `⌘N` opens new patient but conflicts with browser "new window" | Shortcut collision in web. | Rebind to `⌘/` or `C` and use an omnibox/command palette. |
| Light theme only half-implemented | Visual polish is inconsistent. | Design from the start with light and dark themes. |
| Low contrast tertiary text (`3.5:1`, `2.5:1`) | Accessibility fail. | All text meets WCAG AA 4.5:1 minimum. |

### 1.3 What works well and should be kept

- Patient sidebar + mode tabs as the primary navigation model.
- Zustand-based global store for chat streams and drafts (browser tabs can reuse this).
- Streaming SSE chat with reasoning pane, citations, and memory-ingest status.
- Mode-specific context rail on the right.
- Shared primitive components in `ui.tsx`.
- Flat i18n dictionary structure.

---

## 2. Design principles

1. **Browser native, not desktop emulated.** No fake title bars, no system tray, no menu bar. Use the browser's chrome and the web's interaction patterns.
2. **One patient, one place.** The patient sidebar is the anchor. Selecting a patient keeps context across modes.
3. **One chat, everywhere.** The same composer, bubble, and reasoning components appear in encounter, research, writing, and cross-patient contexts.
4. **Progressive disclosure.** Show the high-signal summary first; let users expand into provenance, raw reasoning, or detailed reports.
5. **Accessibility first.** WCAG AA contrast, keyboard navigation, focus management, and screen-reader labels are non-negotiable.
6. **Self-hosted = SaaS.** The same UI works whether the backend is our cloud droplet or a user's own Docker deployment.

---

## 3. New information architecture

### 3.1 URL routes

```
/                          landing page (marketing)
/login                     login / register
/app                       redirect to /app/today
/app/today                 today overview (cross-patient activity)
/app/patient/:hash         patient summary (default tab)
/app/patient/:hash/chat    encounter chat
/app/patient/:hash/imaging imaging + studies
/app/patient/:hash/labs    labs
/app/patient/:hash/memory  memory / clinical graph
/app/patient/:hash/report  reports
/app/research              research workspace
/app/research/:studyId     study detail
/app/writing               writing studio document list
/app/writing/:docId        document editor
/app/skills                skills manager
/app/settings              settings (LLM, account, data)
/app/admin/users           admin user management
```

### 3.2 Persistent three-column layout

```
┌─────────────────┬───────────────────────────────┬─────────────────┐
│  NAV SIDEBAR    │         MAIN CONTENT          │  CONTEXT RAIL   │
│                 │                               │                 │
│  - App logo     │  - Title / breadcrumb         │  - Reasoning    │
│  - Today        │  - Mode tabs or workspace     │  - Citations    │
│  - Patients     │    content                    │  - Takeaways    │
│  - Research     │                               │  - Actions      │
│  - Writing      │                               │                 │
│  - Skills       │                               │                 │
│  - Settings     │                               │                 │
│                 │                               │                 │
│  User menu      │                               │                 │
└─────────────────┴───────────────────────────────┴─────────────────┘
   240px           flexible (min 640px)              320px
```

- **Nav sidebar** is global and collapsible to icons on narrow screens.
- **Main content** swaps based on route.
- **Context rail** is mode-aware and can be hidden by the user (`⌘J` / `J`).

### 3.3 Patient sub-navigation

When a patient is active, the main content header shows:

```
[Patient Name]  [Summary] [Chat] [Imaging] [Labs] [Memory] [Report]
```

These are route tabs, not a separate tab bar below the header. The patient sidebar highlights the active patient.

---

## 4. Page-by-page redesign

### 4.1 Landing page (`/`)

Already implemented in `packages/web/src/routes/landing.tsx`. Keep the dark gradient hero and clear CTA, but add:

- Feature highlights (3 cards).
- Self-hosting badge ("Run your own instance").
- Link to GitHub and docs.

### 4.2 Login / register (`/login`)

Already implemented. Improvements:

- Split into two cards side by side on desktop instead of a toggle.
- Add "forgot password / claim account" flow.
- Show instance name from `/api/v1/config` for self-hosted users.

### 4.3 Today (`/app/today`)

A dashboard replacing the old `TodayMode`.

**Content:**
- Good morning + practitioner name.
- Quick stats: active patients, pending reports, unresolved conflicts, scheduled tasks.
- Recent activity feed (last chats, uploads, reports).
- Action row: new patient, new document, open command palette.

**Visual:** card grid, not a chat-first view.

### 4.4 Patient summary (`/app/patient/:hash`)

Replace `PatientMode`.

**Content:**
- Header: name/ID, age/sex, last encounter, action menu (archive, delete).
- Findings grid: conditions, medications, recent imaging.
- Conflict banner if `unresolvedConflictCount > 0`.
- Ingest debug banner if no findings and the last chat/upload failed to extract.
- Quick actions: start chat, upload imaging, write report.

**Context rail:** provenance of highlighted findings, citation list.

### 4.5 Encounter chat (`/app/patient/:hash/chat`)

Redesign the chat as the canonical messaging experience.

**Composer:**
- Multi-line textarea that auto-grows.
- `/` skill menu, `#` file reference, `@` patient reference.
- Attachment chips with remove button.
- Send on `Enter`, newline on `Shift+Enter`.
- Stop button during streaming.

**Message list:**
- User messages: right-aligned, subtle surface.
- Agent messages: left-aligned, full surface.
- Timestamp + model/provider badge.
- Reasoning expander, citation chips, web-search result cards, memory-ingest status.
- Copy button on hover.

**Context rail:** live reasoning, citations with source snippets, takeaways drawer.

### 4.6 Imaging (`/app/patient/:hash/imaging`)

Replace `ImagingMode`.

**Content:**
- Upload zone (drag/drop or click) with progress.
- Study list: date, modality, description, thumbnail, quick-scan status.
- Study detail: series list, open viewer button.

**Viewer:**
- Open in a full-screen route `/app/patient/:hash/imaging/:studyId` instead of a new window.
- Use the existing bundled OHIF/Cornerstone viewer served from the backend at `/dicom-viewer/`.
- Because it is same-origin, the session cookie authenticates it; no token in URL.

### 4.7 Labs (`/app/patient/:hash/labs`)

Keep lightweight in M0.

**Content:**
- Upload lab reports/PDFs.
- List extracted lab panels with abnormal-value highlighting.
- Timeline view.

### 4.8 Memory / clinical graph (`/app/patient/:hash/memory`)

Replace `MemoryMode`.

**Content:**
- Graph visualization of entities (nodes) and relationships (edges).
- List view fallback for accessibility.
- Filters by node type: findings, medications, facts, studies.
- Conflict review panel.

**Context rail:** selected node provenance, evidence quote, extraction model/prompt.

### 4.9 Report (`/app/patient/:hash/report`)

Replace `ReportMode`.

**Content:**
- Generated report preview.
- Template picker.
- Edit + regenerate flow.
- Export to PDF / DOCX.

### 4.10 Research workspace (`/app/research`)

Replace `ResearchWorkspace`.

**Changes from desktop-v2:**
- Use the same `base-*` tokens as the rest of the app; drop the separate cyan `rw-*` palette.
- Studies sidebar inside the main content area (not a separate full-screen workspace).
- Tabs: Overview, Eligibility, Roster, Safety, Schedule, Chat, Reports.
- Chat uses the same `MessageBubble` and `ChatComposer` as encounter chat.

### 4.11 Writing studio (`/app/writing`)

Replace `WritingStudio`.

**Changes:**
- Keep the three-pane layout (document list | editor | chat).
- Use the same chat components.
- Modernize the toolbar and reference chips.
- Add version history as a right-rail panel.

### 4.12 Skills manager (`/app/skills`)

Replace `SkillsManagerModal`.

**Content:**
- Installed skills grid with toggle.
- Marketplace search.
- Install/uninstall with confirmation.

### 4.13 Settings (`/app/settings`)

Combine LLM settings, account, data, and admin links.

**Tabs:**
- Profile
- LLM provider + key test
- Data export / archive
- Admin (only visible for `role=admin`)

### 4.14 Admin users (`/app/admin/users`)

Replace `AdminUsersView`.

**Content:**
- User table with role, status, created date.
- Disable/enable, reset password, delete.

---

## 5. Component system

### 5.1 Primitives

A single `ui.tsx`-like package with these atoms:

| Component | Notes |
|---|---|
| `Button` | primary, secondary, danger, ghost, loading state |
| `IconButton` | square button for toolbars |
| `Input` | text, password, search variants |
| `Textarea` | auto-resize variant for composer |
| `Select` | native-styled dropdown |
| `Badge` | status, tier, tag |
| `Card` | default, hover, selected states |
| `Dialog` | accessible modal with focus trap and Esc close |
| `Drawer` | right-side panel |
| `Toast` | queued, with semantic icon and `aria-live` |
| `Skeleton` | loading placeholders |
| `EmptyState` | icon + message + action |
| `Avatar` | user/patient initials |
| `Tooltip` | hover/focus explanations |

### 5.2 Composite components

| Component | Used in |
|---|---|
| `AppShell` | global three-column layout |
| `NavSidebar` | global navigation |
| `PatientList` | sidebar patient registry |
| `ModeTabs` | patient sub-navigation |
| `ContextRail` | right-side reasoning/citations |
| `ChatComposer` | all chat surfaces |
| `MessageBubble` | all chat surfaces |
| `MessageStream` | message list with auto-scroll |
| `ReasoningPane` | agent reasoning steps |
| `CitationChip` / `CitationCard` | inline and rail citations |
| `FileUploadZone` | imaging, labs, writing |
| `StudyCard` | imaging study list |
| `PatientSummaryCard` | patient summary |
| `CommandPalette` | global `⌘K` search |

### 5.3 Chat component contract

All chat surfaces use the same data shape:

```ts
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
  isStreaming?: boolean;
  reasoning?: ReasoningStep[];
  citations?: Citation[];
  webResults?: WebResult[];
  memoryStatus?: MemoryIngestStatus;
  proposal?: ScheduledTaskProposal;
  error?: string;
}
```

The composer emits `{ text, attachments, skills, scope }`.

---

## 6. Visual design direction

### 6.1 Philosophy

- Clean, clinical, trustworthy.
- Dense information without clutter.
- Clear hierarchy through typography and spacing, not color alone.
- Subtle depth with shadows and borders, not heavy gradients.

### 6.2 Color system (single palette)

Replace both `base-*` and `rw-*` with one semantic palette:

```css
/* Light */
--bg: #ffffff;
--surface: #f8fafc;
--surface-elevated: #ffffff;
--border: #e2e8f0;
--border-strong: #cbd5e1;
--text-primary: #0f172a;
--text-secondary: #475569;
--text-tertiary: #64748b;
--accent: #0ea5e9;        /* sky-500 */
--accent-hover: #0284c7;
--success: #16a34a;
--warning: #ca8a04;
--error: #dc2626;

/* Dark */
--bg: #0f172a;
--surface: #1e293b;
--surface-elevated: #334155;
--border: #334155;
--border-strong: #475569;
--text-primary: #f8fafc;
--text-secondary: #cbd5e1;
--text-tertiary: #94a3b8;
--accent: #38bdf8;
--accent-hover: #0ea5e9;
```

All text colors must meet 4.5:1 contrast.

### 6.3 Typography

- **Sans**: Inter or system-ui for UI chrome and body.
- **Serif**: Source Serif 4 or Georgia for report headings.
- **Mono**: JetBrains Mono for IDs, timestamps, code.
- Scale: 12/14/16/20/24/30/36px.

### 6.4 Spacing and shape

- Base unit: 4px.
- Border radius: 6px (inputs), 8px (cards), 12px (dialogs), 16px (drawers).
- Shadows: 0 1px 3px rgba(0,0,0,0.08) for cards, 0 8px 30px for dialogs/drawers.

### 6.5 Responsive breakpoints

- `sm`: 640px — collapsible nav sidebar to icons.
- `md`: 768px — show context rail.
- `lg`: 1024px — full three-column layout.
- `xl`: 1280px — comfortable densities.

On mobile (< 640px), the context rail becomes a bottom sheet and the nav sidebar becomes a hamburger menu.

---

## 7. Interaction patterns

### 7.1 Global shortcuts

| Shortcut | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Open command palette |
| `⌘/` / `Ctrl+/` | New patient |
| `⌘B` / `Ctrl+B` | Toggle nav sidebar |
| `⌘J` / `Ctrl+J` | Toggle context rail |
| `Esc` | Close modal/drawer/palette |
| `?` | Show shortcuts help |

`⌘N` is avoided because it is "new browser window".

### 7.2 Command palette

Universal search:
- Patients by name/ID.
- Modes and routes.
- Recent documents and studies.
- Actions: "new patient", "upload imaging", "open settings".

### 7.3 Draft persistence

Composer drafts and attachments are saved to Zustand + `IndexedDB` keyed by session ID. Users can navigate away and return without losing work.

### 7.4 Loading and error states

- Skeleton screens for initial loads.
- Inline spinners for actions.
- Toast queue for non-blocking errors.
- Inline error banners for blocking failures.
- Retry buttons on failed SSE streams.

---

## 8. Technical notes

### 8.1 Auth

Move from `localStorage` JWT to **httpOnly, SameSite=strict, secure cookies** for the SaaS deployment. Self-hosted deployments can still use the existing JWT flow if they prefer.

For the current `packages/web` M0, keep JWT in `localStorage` as a pragmatic shortcut, but document the migration path to cookies.

### 8.2 DICOM viewer

Serve the existing OHIF/Cornerstone static viewer from the backend at `/dicom-viewer/`. Because it is same-origin, the session cookie authenticates requests. Eliminate the `?token=` URL pattern.

### 8.3 File uploads

- Small files (< 50 MB): direct `XMLHttpRequest` with progress.
- Large DICOM zips: implement tus/resumable upload endpoint and client.

### 8.4 State

Keep Zustand for:
- Auth session
- UI chrome state
- Active patient/session/document
- Chat message cache and drafts

Move large persistent chat histories to `IndexedDB` instead of `localStorage`.

---

## 9. Migration phases

### Phase 0: Foundation (done)

- `packages/web` scaffold with Vite + React + Tailwind + Zustand + React Router.
- Landing, login, chat pages.
- Backend static serving + `/api/v1/config`.

### Phase 1: Patient core

- App shell with nav sidebar and context rail.
- Patient list and patient summary.
- Encounter chat with unified components.
- Settings / LLM.

### Phase 2: Clinical modes

- Imaging + DICOM viewer integration.
- Labs.
- Memory / clinical graph.
- Reports.

### Phase 3: Workspaces

- Research workspace.
- Writing studio.
- Skills manager.

### Phase 4: Polish

- Dark mode.
- Command palette.
- Toast queue.
- i18n parity.
- Accessibility audit.
- Remove `packages/desktop-v2`.

---

## 10. Open questions

1. Do we want a **single cookie-based auth** implementation, or keep JWT for self-hosted and cookies for SaaS?
2. Should the DICOM viewer open **in-app** (`/app/patient/:hash/imaging/:studyId`) or in a **separate viewer route** (`/viewer?studyId=...`)?
3. Do we need a **mobile-optimized** layout, or is tablet/desktop the primary target?
4. Should **dark mode** be implemented now or deferred to Phase 4?
5. Do we keep the **Chinese-first i18n** default, or make English the default for the web SaaS?

---

## 11. Related documents

- `docs/adr/ADR-003-web-ui-saas-pivot.md` — architectural decision.
- `docs/design/UI_UX_REVIEW_2026-07.md` — prior audit of desktop-v2 issues.
