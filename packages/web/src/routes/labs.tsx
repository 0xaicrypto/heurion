import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { FileText, Upload, ClipboardList } from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Badge, Button, Card, Skeleton } from '@/components/ui';

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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const nonDicomMimes = /(pdf|word|spreadsheet|csv|text|excel|powerpoint)/i;

export function LabsPage() {
  const { hash } = useParams<{ hash: string }>();
  const [files, setFiles] = useState<UploadEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadFiles = useCallback(() => {
    if (!hash) return;
    setLoading(true);
    setError(null);
    api
      .getUploads(hash)
      .then((data) => setFiles(data.filter((f) => nonDicomMimes.test(f.mime))))
      .catch((err) => setError(err instanceof ApiError ? err.messageText : String(err)))
      .finally(() => setLoading(false));
  }, [hash]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      await api.uploadFile(file, hash);
      loadFiles();
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  if (!hash) {
    return (
      <div className="flex h-full items-center justify-center text-text-tertiary">
        <p>No patient selected</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Lab Results & Documents</h2>
          <p className="text-sm text-text-secondary">Uploaded lab files and reports</p>
        </div>
        <Button size="sm" onClick={() => fileInputRef.current?.click()} isLoading={uploading}>
          <Upload size={14} className="mr-1" /> Upload
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          onChange={handleUpload}
          className="hidden"
          disabled={uploading}
        />
      </div>

      {error && (
        <div className="mb-4">
          <Alert variant="error">{error}</Alert>
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </div>
      ) : files.length === 0 ? (
        <Card className="flex flex-col items-center justify-center p-12 text-center">
          <ClipboardList size={40} className="mb-3 text-text-tertiary" />
          <p className="text-sm font-medium text-text-primary">No lab documents yet</p>
          <p className="text-xs text-text-secondary">Upload lab results or reports for this patient</p>
        </Card>
      ) : (
        <div className="space-y-2">
          {files.map((f) => (
            <Card key={f.file_id} className="flex items-center gap-4 p-4">
              <FileText size={20} className="shrink-0 text-text-tertiary" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text-primary">{f.name}</p>
                <p className="text-xs text-text-tertiary">
                  {f.mime} · {formatBytes(f.size_bytes)} · Uploaded {new Date(f.created_at).toLocaleDateString()}
                </p>
              </div>
              <Badge variant="default">{f.mime.split('/')[0]}</Badge>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
