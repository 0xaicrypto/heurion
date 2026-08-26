import { ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

/**
 * #709 — 患者子页移动端返回按钮。
 * imaging/labs/memory/report 四页在移动端（患者列表只在 !hash 时显示）
 * 没有返回路径；桌面端有侧边栏可回，移动端只能靠它。
 */
export function PatientBackButton({ hash }: { hash?: string }) {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => navigate(`/app/patients/${hash ?? ''}`)}
      className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-surface text-text-secondary transition-colors hover:bg-surface-elevated hover:text-text-primary lg:hidden"
      aria-label="返回患者"
      title="返回患者"
    >
      <ArrowLeft size={16} />
    </button>
  );
}
