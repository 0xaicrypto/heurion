/**
 * Shell composition — global header, patients sidebar, main canvas tabs,
 * context rail. Per docs/design/nexus-architecture.md §5.
 */

import { useState } from 'react';
import { Search, Plus, User, ChevronLeft, ChevronRight, PanelRight, Trash2 } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { useAppState } from '../store';
import { api, ApiError } from '../lib/api-client';
import { cn, patientDisplayLabel, type ModeKind, type PatientCard } from '../lib/util';
import { useT, useModeLabel } from '../lib/i18n';
import { Button, Chip, StatusDot, Input } from './ui';
import { useHeadWindow } from './windowed-list';
import { AccountMenu } from './overlays';
import { IdentityPicker } from './identity-picker';

/* ───────────── GlobalHeader (48px) ───────────── */

export function GlobalHeader() {
  const t = useT();
  const openCommandPalette  = useAppState((s) => s.openCommandPalette);
  const openNewPatientDialog = useAppState((s) => s.openNewPatientDialog);

  return (
    <header
      className={cn(
        'drag flex h-12 shrink-0 items-center justify-between',
        'border-b border-border bg-bg px-3',
      )}
    >
      <div className="no-drag flex items-center gap-1">
        <button
          className="rounded-sm p-1.5 text-text-tertiary hover:bg-accent-subtle hover:text-text-primary"
          aria-label={t('header.back')}
        >
          <ChevronLeft size={16} />
        </button>
        <button
          className="rounded-sm p-1.5 text-text-tertiary hover:bg-accent-subtle hover:text-text-primary"
          aria-label={t('header.forward')}
        >
          <ChevronRight size={16} />
        </button>

        {/* ⌘K command palette trigger */}
        <button
          onClick={openCommandPalette}
          className={cn(
            'no-drag ml-2 flex items-center gap-2 rounded-sm border border-border',
            'px-2.5 py-1 text-caption text-text-tertiary',
            'hover:border-border-strong hover:text-text-secondary',
            'transition-colors duration-80',
          )}
        >
          <Search size={12} />
          <span>{t('header.search')}</span>
          <span className="ml-6 font-mono text-[10px]">⌘K</span>
        </button>
      </div>

      <div className="font-display text-[15px] font-semibold tracking-tight">
        Nexus
      </div>

      <div className="no-drag flex items-center gap-2">
        <Button
          variant="ghost"
          className="!px-2 !py-1 !text-[13px]"
          onClick={openNewPatientDialog}
        >
          <Plus size={14} />
          {t('header.newPatient')}
        </Button>

        {/* F26.2 — Multi-identity picker. The pill renders the current
            identity's emoji + name; click to dropdown the full list +
            "add new" footer. See components/identity-picker.tsx. */}
        <IdentityPicker />

        <AccountMenu
          trigger={
            <button
              className="rounded-sm p-1.5 text-text-tertiary hover:bg-accent-subtle hover:text-text-primary"
              aria-label={t('header.account')}
            >
              <User size={16} />
            </button>
          }
        />
      </div>
    </header>
  );
}

/* ───────────── PatientsSidebar (260px) ───────────── */

export function PatientsSidebar() {
  const t = useT();
  const patients         = useAppState((s) => s.patients);
  const activePatient    = useAppState((s) => s.activePatient);
  const setActivePatient = useAppState((s) => s.setActivePatient);
  const collapsed        = useAppState((s) => s.sidebarCollapsed);

  const pinned = patients.filter((p) => Date.now() / 1000 - p.lastSeenAt < 86400);
  const others = patients.filter((p) => !pinned.includes(p));

  // UI_UX_REVIEW §6 — windowed "All" list. Only the first slice is
  // mounted; "show more" extends the window. (react-window couldn't be
  // added; this fallback keeps DOM size O(visible) for large rosters.)
  // NOTE: hook must run before the `collapsed` early return.
  const {
    visible: visibleOthers,
    hiddenCount: hiddenOthers,
    showMore: showMoreOthers,
  } = useHeadWindow(others, 40, 200);

  if (collapsed) {
    return (
      <aside className="flex h-full w-14 shrink-0 flex-col items-center gap-2 border-r border-border bg-bg pt-3">
        {/* F-today-back — collapsed icon for the return entry. */}
        <button
          type="button"
          onClick={() => {
            setActivePatient(null);
            useAppState.getState().setActiveMode('today');
          }}
          className={cn(
            'flex h-9 w-9 items-center justify-center rounded-sm text-[14px]',
            !activePatient
              ? 'bg-accent-subtle text-accent'
              : 'text-text-secondary hover:bg-accent-subtle',
          )}
          title={t('sidebar.home')}
        >
          ←
        </button>
        {patients.slice(0, 8).map((p) => (
          <button
            key={p.patientHash}
            onClick={() => setActivePatient(p)}
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-sm font-mono text-[11px]',
              'hover:bg-accent-subtle',
              p.patientHash === activePatient?.patientHash
                ? 'bg-accent-subtle text-accent'
                : 'text-text-secondary',
            )}
            title={patientDisplayLabel(p)}
          >
            {p.initials
              ? p.initials.replace(/\./g, '').slice(0, 2).toUpperCase()
              : (p.sequenceNumber > 0 ? `#${p.sequenceNumber}` : '?')}
          </button>
        ))}
      </aside>
    );
  }

  return (
    // Use the Research palette so the patient sidebar shares one visual
    // language with research-workspace.tsx StudiesSidebar (rw-bg /
    // rw-border / accent-bd active state). Without this the two
    // workspaces feel like two different apps.
    <aside className="flex h-full w-[260px] shrink-0 flex-col border-r border-rw-border bg-rw-bg">
      <div className="border-b border-rw-border p-3 space-y-2">
        {/* F-today-back — explicit return entry. Without this the medic
            gets stuck inside PatientMode after clicking a sidebar
            patient. Clicking 工作台首页 clears the active patient AND
            switches the mode back to today, mirroring the "back to
            inbox" affordance every email client has. */}
        <button
          type="button"
          onClick={() => {
            setActivePatient(null);
            useAppState.getState().setActiveMode('today');
          }}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-caption transition',
            !activePatient
              ? 'bg-rw-accent-bg text-rw-accent border border-rw-accent-bd'
              : 'text-rw-t2 hover:bg-rw-surface border border-transparent',
          )}
        >
          <span aria-hidden>←</span>
          <span>{t('sidebar.home')}</span>
        </button>
        <Input placeholder={t('sidebar.filter')} className="!text-caption" />
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        {pinned.length > 0 && (
          <PatientGroup title={t('sidebar.pinned')}>
            {pinned.map((p) => (
              <PatientRow
                key={p.patientHash}
                patient={p}
                selected={p.patientHash === activePatient?.patientHash}
                onClick={() => setActivePatient(p)}
              />
            ))}
          </PatientGroup>
        )}

        {others.length > 0 && (
          <PatientGroup title={t('sidebar.all')}>
            {visibleOthers.map((p) => (
              <PatientRow
                key={p.patientHash}
                patient={p}
                selected={p.patientHash === activePatient?.patientHash}
                onClick={() => setActivePatient(p)}
              />
            ))}
            {hiddenOthers > 0 && (
              <button
                type="button"
                onClick={showMoreOthers}
                className="mx-1 mt-1 rounded-md border border-rw-border px-2 py-1.5
                           text-caption text-rw-t3 hover:bg-rw-surface hover:text-rw-t1"
              >
                {t('list.showMore', { count: hiddenOthers })}
              </button>
            )}
          </PatientGroup>
        )}
      </div>
    </aside>
  );
}

function PatientGroup({ title, children }: { title: string; children: React.ReactNode }) {
  // SMALL-CAPS section heading matches the "RESEARCH / MY STUDIES"
  // headings in research-workspace.tsx — same hierarchy treatment on
  // both sides of the segmented control.
  return (
    <div className="mb-4">
      <div className="px-2 pb-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-rw-t4">
        {title}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function PatientRow({
  patient, selected, onClick,
}: {
  patient: PatientCard;
  selected: boolean;
  onClick: () => void;
}) {
  const t = useT();
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Render as a wrapper div with the click handler instead of a <button>
  // because we want a NESTED button (trash icon) for delete, which is
  // invalid HTML if the outer element is also a <button>.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onClick();
      }}
      className={cn(
        // Selected row uses the rw-accent treatment — same as the
        // active study card in StudiesSidebar (research-workspace.tsx).
        'group flex w-full cursor-pointer items-center justify-between rounded-md px-2 py-2 text-left border',
        'transition-colors duration-80',
        selected
          ? 'bg-rw-accent-bg text-rw-t1 border-rw-accent-bd'
          : 'border-transparent text-rw-t2 hover:bg-rw-surface hover:text-rw-t1',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-caption">
            {patientDisplayLabel(patient)}
          </span>
          {patient.unreadAgent && <StatusDot kind="unread" />}
          {patient.hasConflict && <StatusDot kind="caution" />}
        </div>
        <div className="mt-0.5 text-[11px] text-text-tertiary">
          {patient.sex || '—'} · {patient.ageGroup || '—'}
        </div>
      </div>
      <div className="ml-2 flex shrink-0 items-center gap-1">
        <Chip mono variant="neutral">
          {patient.latestModality || '—'}
        </Chip>
        <button
          aria-label={`${t('patient.deleteBtn')} ${patientDisplayLabel(patient)}`}
          onClick={(e) => {
            // Don't let the row's click handler also fire.
            e.stopPropagation();
            setConfirmOpen(true);
          }}
          className={cn(
            'rounded-sm p-1 opacity-0 transition-opacity duration-80',
            'text-text-tertiary hover:bg-retract/10 hover:text-retract',
            'group-hover:opacity-100 focus:opacity-100',
          )}
          title={t('patient.deleteBtn')}
        >
          <Trash2 size={12} />
        </button>
      </div>

      <DeletePatientDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        patient={patient}
      />
    </div>
  );
}

/* ───────────── DeletePatientDialog ───────────── */
/* Confirm + execute DELETE /api/v1/dicom/patients/{hash}. Cascade is
 * server-side (manual row + DICOM aggregates + uploads + patient_memory
 * + clinical_graph_nodes; sessions are un-bound, not deleted).         */

function DeletePatientDialog({
  open, onOpenChange, patient,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  patient: PatientCard;
}) {
  const t = useT();
  const refreshPatients  = useAppState((s) => s.refreshPatients);
  const activePatient    = useAppState((s) => s.activePatient);
  const setActivePatient = useAppState((s) => s.setActivePatient);
  const hidePatient      = useAppState((s) => s.hidePatient);
  const showToast        = useAppState((s) => s.showToast);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = (label: string) => {
    if (activePatient?.patientHash === patient.patientHash) {
      setActivePatient(null);
    }
    onOpenChange(false);
    showToast(label, 'success');
  };

  const onConfirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.deletePatient(patient.patientHash);
      await refreshPatients();
      const counts = Object.entries(r.deleted)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k}:${n}`)
        .join(' · ');
      finish(
        `Deleted ${patientDisplayLabel(patient)}${counts ? ' (' + counts + ')' : ''}`,
      );
    } catch (e) {
      // The backend doesn't have the DELETE endpoint yet (stale
      // sidecar). Fall back to a client-side hide so the patient
      // disappears NOW. When the user rebuilds the sidecar, the next
      // refresh's real DELETE removes the row server-side and our
      // hide list converges (filtered-out hashes that aren't on the
      // server anyway are harmless).
      const looksLikeMissingRoute = e instanceof ApiError
        && e.status === 404
        && /"detail"\s*:\s*"Not Found"/.test(e.message);
      const isNetwork = e instanceof TypeError;

      if (looksLikeMissingRoute) {
        hidePatient(patient.patientHash);
        finish(
          `Hidden ${patientDisplayLabel(patient)} (server lacks DELETE — rebuild sidecar to purge from disk)`,
        );
      } else if (isNetwork) {
        setError('Cannot reach server. Is the backend running?');
      } else if (e instanceof ApiError) {
        setError(`Server rejected (${e.status}): ${e.message}`);
      } else {
        setError(String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2',
            'rounded-lg border border-border-strong bg-surface p-6 shadow-2xl',
            'focus:outline-none',
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <Dialog.Title asChild>
            <h2 className="mb-2 font-display text-section text-text-primary">
              {t('patient.deleteBtn')}？
            </h2>
          </Dialog.Title>
          <Dialog.Description className="mb-4 text-body text-text-secondary">
            <strong className="text-text-primary">{patientDisplayLabel(patient)}</strong>
            {' '}— removes the patient row plus their DICOM studies, uploads,
            memory, and graph projection. Chat sessions are kept (un-bound).
          </Dialog.Description>
          <p className="mb-4 text-caption text-text-tertiary">
            The underlying <span className="font-mono">twin_event_log</span> is
            append-only and is NOT touched — the record is recoverable by
            event-log replay if you change your mind.
          </p>
          {error && (
            <div className="mb-3 rounded-sm border border-retract/40 bg-retract/10 px-3 py-2 text-caption text-retract">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              {t('newPatient.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={onConfirm}
              disabled={busy}
              className="!bg-retract hover:!bg-retract/90"
            >
              {busy ? t('patient.deleting') : t('patient.deleteBtn')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ───────────── MainCanvas mode tabs ───────────── */

const MODES_VISIBLE_WITH_PATIENT: ModeKind[] = [
  'patient', 'encounter', 'imaging', 'labs', 'memory', 'report',
];

export function ModeTabs() {
  const t = useT();
  const modeLabel         = useModeLabel();
  const activePatient     = useAppState((s) => s.activePatient);
  const activeMode        = useAppState((s) => s.activeMode);
  const setActiveMode     = useAppState((s) => s.setActiveMode);
  const toggleContextRail = useAppState((s) => s.toggleContextRail);

  if (!activePatient) {
    return <div className="h-12 shrink-0 border-b border-border bg-bg" />;
  }

  return (
    <div className="flex h-12 shrink-0 items-center justify-between border-b border-rw-border bg-rw-bg px-4">
      <div className="flex flex-wrap items-center gap-1">
        {MODES_VISIBLE_WITH_PATIENT.map((m) => (
          // Patient mode pills — same shape as Research StudyHeader's
          // tab pills (see research-workspace.tsx :281), so the two
          // workspaces share one segmented-tab visual language.
          <button
            key={m}
            onClick={() => setActiveMode(m)}
            className={cn(
              'rounded-md px-3 py-1.5 text-[13px] transition border',
              activeMode === m
                ? 'bg-rw-accent-bg text-rw-accent border-rw-accent-bd'
                : 'text-rw-t2 border-transparent hover:bg-rw-surface',
            )}
          >
            {modeLabel(m)}
          </button>
        ))}
      </div>

      <button
        onClick={toggleContextRail}
        className="rounded-sm p-1.5 text-text-tertiary hover:bg-accent-subtle hover:text-text-primary"
        title={t('header.contextRail')}
      >
        <PanelRight size={16} />
      </button>
    </div>
  );
}
