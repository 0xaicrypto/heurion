/**
 * Shell composition — global header, patients sidebar, main canvas tabs,
 * context rail. Per docs/design/nexus-ux-redesign.md §5.
 */

import { useState } from 'react';
import { Search, Plus, User, ChevronLeft, ChevronRight, PanelRight, Trash2 } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { useAppState } from '../store';
import { api, ApiError } from '../lib/api-client';
import { cn, MODE_LABELS, patientDisplayLabel, type ModeKind, type PatientCard } from '../lib/util';
import { Button, Chip, StatusDot, Input } from './ui';
import { AccountMenu } from './overlays';

/* ───────────── GlobalHeader (48px) ───────────── */

export function GlobalHeader() {
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
          aria-label="Back"
        >
          <ChevronLeft size={16} />
        </button>
        <button
          className="rounded-sm p-1.5 text-text-tertiary hover:bg-accent-subtle hover:text-text-primary"
          aria-label="Forward"
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
          <span>Search…</span>
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
          New patient
        </Button>

        <AccountMenu
          trigger={
            <button
              className="rounded-sm p-1.5 text-text-tertiary hover:bg-accent-subtle hover:text-text-primary"
              aria-label="Account"
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
  const patients         = useAppState((s) => s.patients);
  const activePatient    = useAppState((s) => s.activePatient);
  const setActivePatient = useAppState((s) => s.setActivePatient);
  const collapsed        = useAppState((s) => s.sidebarCollapsed);

  if (collapsed) {
    return (
      <aside className="flex h-full w-14 shrink-0 flex-col items-center gap-2 border-r border-border bg-bg pt-3">
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

  const pinned = patients.filter((p) => Date.now() / 1000 - p.lastSeenAt < 86400);
  const others = patients.filter((p) => !pinned.includes(p));

  return (
    <aside className="flex h-full w-[260px] shrink-0 flex-col border-r border-border bg-bg">
      <div className="border-b border-border p-3">
        <Input placeholder="Filter patients…" className="!text-caption" />
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        {pinned.length > 0 && (
          <PatientGroup title="Pinned today">
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
          <PatientGroup title="All">
            {others.map((p) => (
              <PatientRow
                key={p.patientHash}
                patient={p}
                selected={p.patientHash === activePatient?.patientHash}
                onClick={() => setActivePatient(p)}
              />
            ))}
          </PatientGroup>
        )}
      </div>
    </aside>
  );
}

function PatientGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="px-2 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-text-tertiary">
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
        'group flex w-full cursor-pointer items-center justify-between rounded-sm px-2 py-2 text-left',
        'transition-colors duration-80',
        selected
          ? 'bg-accent-subtle text-text-primary'
          : 'hover:bg-accent-subtle text-text-secondary hover:text-text-primary',
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
          aria-label={`Delete ${patientDisplayLabel(patient)}`}
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
          title="Delete patient"
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
              Delete patient?
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
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={onConfirm}
              disabled={busy}
              className="!bg-retract hover:!bg-retract/90"
            >
              {busy ? 'Deleting…' : 'Delete patient'}
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
  const activePatient     = useAppState((s) => s.activePatient);
  const activeMode        = useAppState((s) => s.activeMode);
  const setActiveMode     = useAppState((s) => s.setActiveMode);
  const toggleContextRail = useAppState((s) => s.toggleContextRail);

  if (!activePatient) {
    return <div className="h-12 shrink-0 border-b border-border bg-bg" />;
  }

  return (
    <div className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-bg px-4">
      <div className="flex items-center gap-1">
        {MODES_VISIBLE_WITH_PATIENT.map((m) => (
          <button
            key={m}
            onClick={() => setActiveMode(m)}
            className={cn(
              'rounded-sm px-3 py-1.5 text-caption transition-colors duration-80',
              activeMode === m
                ? 'bg-surface text-text-primary border border-border'
                : 'text-text-secondary hover:text-text-primary',
            )}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>

      <button
        onClick={toggleContextRail}
        className="rounded-sm p-1.5 text-text-tertiary hover:bg-accent-subtle hover:text-text-primary"
        title="Context (⌘.)"
      >
        <PanelRight size={16} />
      </button>
    </div>
  );
}
