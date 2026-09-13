import { useEffect } from 'react';

/** #996/#1001: 底部弹层（移动端）— 视图切换/菜单/聊天的窄屏形态。
 *  仅 md 以下渲染（桌面用浮层/胶囊），遮罩点击/Esc 关闭，安全区适配。 */
export function BottomSheet({
  open, onClose, title, children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div className="absolute inset-x-0 bottom-0 max-h-[70dvh] overflow-y-auto rounded-t-2xl border-t border-border bg-surface-elevated p-3 shadow-xl"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)' }}
      >
        {title && <p className="mb-2 text-center text-xs font-medium text-text-tertiary">{title}</p>}
        {children}
      </div>
    </div>
  );
}
