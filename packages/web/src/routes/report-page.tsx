import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { FileDown, FileText } from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Badge, Button, Card, Skeleton, Textarea } from '@/components/ui';
import type { PatientDetail } from '@/lib/types';

export function ReportPage() {
  const { hash } = useParams<{ hash: string }>();
  const [patient, setPatient] = useState<PatientDetail | null>(null);
  const [patientLoading, setPatientLoading] = useState(true);
  const [clinicalInfo, setClinicalInfo] = useState('');
  const [impression, setImpression] = useState('');
  const [recommendation, setRecommendation] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ pdf_path: string; size_bytes: number; filename: string } | null>(null);

  useEffect(() => {
    if (!hash) return;
    setPatientLoading(true);
    api
      .getPatientDetail(hash)
      .then(setPatient)
      .catch(() => {})
      .finally(() => setPatientLoading(false));
  }, [hash]);

  const handleGenerate = async () => {
    if (!hash) return;
    setGenerating(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.generateReport({
        patient_hash: hash,
        patient_label: patient?.initials || undefined,
        patient_sex: patient?.sex || undefined,
        patient_age_group: patient?.age_group || undefined,
        clinical_info: clinicalInfo || undefined,
        impression: impression || undefined,
        recommendation: recommendation || undefined,
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : String(err));
    } finally {
      setGenerating(false);
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
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-text-primary">Generate Clinical Report</h2>
        <p className="text-sm text-text-secondary">Create a structured PDF report for this patient</p>
      </div>

      {patientLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-32 w-full rounded-xl" />
        </div>
      ) : (
        <Card className="mb-6 p-6">
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-text-tertiary">Patient</label>
                <p className="text-sm text-text-primary">{patient?.initials || hash.slice(0, 8)}</p>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-text-tertiary">Sex</label>
                <p className="text-sm text-text-primary">{patient?.sex || '—'}</p>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-text-tertiary">Age Group</label>
                <p className="text-sm text-text-primary">{patient?.age_group || '—'}</p>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-text-primary">Clinical Information</label>
              <Textarea
                value={clinicalInfo}
                onChange={(e) => setClinicalInfo(e.target.value)}
                placeholder="Enter relevant clinical history and context..."
                rows={4}
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-text-primary">Impression</label>
              <Textarea
                value={impression}
                onChange={(e) => setImpression(e.target.value)}
                placeholder="Diagnostic impression and findings..."
                rows={4}
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-text-primary">Recommendation</label>
              <Textarea
                value={recommendation}
                onChange={(e) => setRecommendation(e.target.value)}
                placeholder="Follow-up recommendations and treatment plan..."
                rows={3}
              />
            </div>

            <Button onClick={handleGenerate} isLoading={generating} className="w-full">
              <FileDown size={16} className="mr-2" /> Generate Report PDF
            </Button>
          </div>
        </Card>
      )}

      {error && (
        <div className="mb-4">
          <Alert variant="error">{error}</Alert>
        </div>
      )}

      {result && (
        <Card className="p-6">
          <div className="flex items-start gap-4">
            <FileText size={24} className="shrink-0 text-success" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-text-primary">Report Generated Successfully</p>
              <p className="text-sm text-text-secondary">Filename: {result.filename}</p>
              <p className="text-sm text-text-tertiary">
                Path: {result.pdf_path} · {(result.size_bytes / 1024).toFixed(1)} KB
              </p>
            </div>
            <Badge variant="success">PDF Ready</Badge>
          </div>
        </Card>
      )}
    </div>
  );
}
