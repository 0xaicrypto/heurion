import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FileDown, FileText, Sparkles } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { PatientBackButton } from '@/components/PatientBackButton';
import { Alert, Button, Card, Skeleton, Textarea } from '@/components/ui';
import type { PatientDetail } from '@/lib/types';

export function ReportPage() {
  const { t } = useTranslation();
  const { hash } = useParams<{ hash: string }>();
  const [patient, setPatient] = useState<PatientDetail | null>(null);
  const [patientLoading, setPatientLoading] = useState(true);
  const [clinicalInfo, setClinicalInfo] = useState('');
  const [impression, setImpression] = useState('');
  const [recommendation, setRecommendation] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ path: string; bytes: number; created_at: number; patient_hash: string } | null>(null);
  // #724: AI 记忆投影 — 一键预填,避免用户在对话里整理好的病史手抄一遍。
  const [projectionLoading, setProjectionLoading] = useState(false);

  useEffect(() => {
    if (!hash) return;
    setPatientLoading(true);
    api
      .getPatientDetail(hash)
      .then(setPatient)
      .catch(() => {})
      .finally(() => setPatientLoading(false));
  }, [hash]);

  /** #724: 拉取记忆投影并预填三个文本域。 */
  const handlePrefillFromMemory = async () => {
    if (!hash) return;
    setProjectionLoading(true);
    setError(null);
    try {
      const p = await api.getMemoryProjection(hash);
      const findings = (p.findings ?? []).map((f) => f.content).filter(Boolean).join('\n');
      const mr = p.medical_record?.sections;
      const infoParts = [
        mr?.chief_complaint,
        mr?.diagnosis,
        ...(findings ? [findings] : []),
      ].filter(Boolean) as string[];
      setClinicalInfo((prev) => prev || infoParts.join('\n'));
      setImpression((prev) => prev || (mr?.progress_notes ?? ''));
      setRecommendation((prev) => prev || (mr?.treatment_plan ?? ''));
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : t('report.prefillFailed', '记忆投影加载失败'));
    } finally {
      setProjectionLoading(false);
    }
  };

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
      <div className="mb-6 flex items-center gap-3">
        {/* #709: 移动端返回患者 — 此前无任何返回入口 */}
        <PatientBackButton hash={hash} />
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Generate Clinical Report</h2>
          <p className="text-sm text-text-secondary">Create a structured PDF report for this patient</p>
        </div>
      </div>

      {patientLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-32 w-full rounded-xl" />
        </div>
      ) : (
        <Card className="mb-6 p-6">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm text-text-secondary">{t('report.prefillHint', '基于 AI 记忆自动预填，或手动填写')}</p>
            {/* #724: 从对话整理好的记忆投影一键预填,免手抄。 */}
            <Button size="sm" variant="secondary" onClick={handlePrefillFromMemory} isLoading={projectionLoading}>
              <Sparkles size={14} className="mr-1" /> {t('report.prefillFromMemory', '从 AI 记忆预填')}
            </Button>
          </div>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
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

      {result && hash && (
        <Card className="p-6">
          <div className="flex items-start gap-4">
            <FileText size={24} className="shrink-0 text-success" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-text-primary">Report Generated Successfully</p>
              <p className="text-sm text-text-tertiary">
                {(result.bytes / 1024).toFixed(1)} KB · {new Date(result.created_at * 1000).toLocaleString()}
              </p>
            </div>
            <a href={api.downloadReportUrl(hash)} target="_blank" rel="noreferrer">
              <Button size="sm">
                <FileDown size={14} className="mr-1" /> Download PDF
              </Button>
            </a>
          </div>
        </Card>
      )}
    </div>
  );
}
