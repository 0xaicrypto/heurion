import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ChevronDown,
  ChevronRight,
  Eye,
  FileText,
  Scan,
  Upload,
  Zap,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Button, Card, Skeleton } from '@/components/ui';
import { cn } from '@/lib/utils';

interface Study {
  study_id: string;
  modality: string;
  body_part?: string;
  series_count: number;
  created_at: string;
}

interface UploadEntry {
  file_id: string;
  name: string;
  mime: string;
  size_bytes: number;
  created_at: string;
  patient_hash?: string;
  dicom_status?: string;
  dicom_study_id?: string;
}

const modalityColors: Record<string, string> = {
  CT: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  MR: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  XR: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  US: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  NM: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
  PT: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
  CR: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  DX: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400',
  MG: 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-400',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ImagingPage() {
  const { hash } = useParams<{ hash: string }>();
  const navigate = useNavigate();
  const [studies, setStudies] = useState<Study[]>([]);
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadsLoading, setUploadsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedStudies, setExpandedStudies] = useState<Set<string>>(new Set());
  const [scanningStudy, setScanningStudy] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  const loadData = useCallback(() => {
    if (!hash) return;
    setLoading(true);
    setError(null);
    api
      .getPatientStudies(hash)
      .then(setStudies)
      .catch((err) => setError(err instanceof ApiError ? err.messageText : String(err)))
      .finally(() => setLoading(false));

    setUploadsLoading(true);
    api
      .getUploads(hash)
      .then(setUploads)
      .catch(() => {})
      .finally(() => setUploadsLoading(false));
  }, [hash]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const toggleExpand = (studyId: string) => {
    setExpandedStudies((prev) => {
      const next = new Set(prev);
      if (next.has(studyId)) next.delete(studyId);
      else next.add(studyId);
      return next;
    });
  };

  const handleQuickScan = async (studyId: string) => {
    setScanningStudy(studyId);
    setScanError(null);
    try {
      await api.triggerQuickScan(studyId);
    } catch (err) {
      setScanError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setScanningStudy(null);
    }
  };

  if (!hash) {
    return (
      <div className="flex h-full items-center justify-center text-text-tertiary">
        <p>No patient selected</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Alert variant="error">{error}</Alert>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      {scanError && (
        <div className="mb-4">
          <Alert variant="error">{scanError}</Alert>
        </div>
      )}

      <section className="mb-8">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">DICOM Studies</h2>
          {!loading && (
            <span className="text-sm text-text-tertiary">{studies.length} studies</span>
          )}
        </div>

        {loading ? (
          <div className="space-y-4">
            <Skeleton className="h-24 w-full rounded-xl" />
            <Skeleton className="h-24 w-full rounded-xl" />
            <Skeleton className="h-24 w-full rounded-xl" />
          </div>
        ) : studies.length === 0 ? (
          <Card className="flex flex-col items-center justify-center p-12 text-center">
            <Scan size={40} className="mb-3 text-text-tertiary" />
            <p className="text-sm text-text-secondary">No imaging studies found for this patient</p>
          </Card>
        ) : (
          <div className="space-y-3">
            {studies.map((study) => (
              <StudyCard
                key={study.study_id}
                study={study}
                expanded={expandedStudies.has(study.study_id)}
                onToggle={() => toggleExpand(study.study_id)}
                onView={() => navigate(`/app/viewer/${study.study_id}`)}
                onQuickScan={() => handleQuickScan(study.study_id)}
                scanning={scanningStudy === study.study_id}
              />
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">File Uploads</h2>
          {!uploadsLoading && (
            <span className="text-sm text-text-tertiary">{uploads.length} files</span>
          )}
        </div>

        {uploadsLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
          </div>
        ) : uploads.length === 0 ? (
          <Card className="flex flex-col items-center justify-center p-12 text-center">
            <Upload size={40} className="mb-3 text-text-tertiary" />
            <p className="text-sm text-text-secondary">No file uploads for this patient</p>
          </Card>
        ) : (
          <div className="space-y-2">
            {uploads.map((u) => (
              <Card key={u.file_id} className="flex items-center gap-4 p-4">
                <FileText size={20} className="shrink-0 text-text-tertiary" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-text-primary">{u.name}</p>
                  <p className="text-xs text-text-tertiary">
                    {u.mime} · {formatBytes(u.size_bytes)} · {new Date(u.created_at).toLocaleDateString()}
                    {u.dicom_status && <> · {u.dicom_status}</>}
                  </p>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function StudyCard({
  study,
  expanded,
  onToggle,
  onView,
  onQuickScan,
  scanning,
}: {
  study: Study;
  expanded: boolean;
  onToggle: () => void;
  onView: () => void;
  onQuickScan: () => void;
  scanning: boolean;
}) {
  const colorClass = modalityColors[study.modality] || 'bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400';

  return (
    <Card className="overflow-hidden">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-4 p-4 text-left transition-colors hover:bg-surface/50"
      >
        <span className="shrink-0">
          {expanded ? <ChevronDown size={18} className="text-text-tertiary" /> : <ChevronRight size={18} className="text-text-tertiary" />}
        </span>
        <span className={cn('shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold', colorClass)}>
          {study.modality}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text-primary">
            {study.body_part || study.modality} Study
          </p>
          <p className="text-xs text-text-tertiary">
            {study.series_count} series · {new Date(study.created_at).toLocaleDateString()}
          </p>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border px-4 py-3">
          <div className="mb-3 space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-text-tertiary">Study ID</span>
              <span className="font-mono text-xs text-text-secondary">{study.study_id.slice(0, 16)}...</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-tertiary">Series Count</span>
              <span className="text-text-primary">{study.series_count}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-tertiary">Created</span>
              <span className="text-text-primary">{new Date(study.created_at).toLocaleString()}</span>
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={onView}>
              <Eye size={14} className="mr-1" /> View
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={onQuickScan}
              isLoading={scanning}
            >
              <Zap size={14} className="mr-1" /> Quick Scan
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
