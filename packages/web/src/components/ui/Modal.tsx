import { useEffect, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * #922 重复实现收敛 — 共享 Modal 容器。
 *
 * 统一 6 处手写 `fixed inset-0 z-50 …bg-black/xx` 弹窗外壳(chat.tsx 关闭确认、
 * knowledge.tsx 总结编辑、KbPicker、RejectReasonDialog、NewPatientDialog、
 * SkillCapturePrompt)。#922 原则:各弹窗原行为不一致,**不许默默统一** —
 * backdrop 点击关闭 / Esc 关闭均以 props 显式开启,调用点逐处对照原行为:
 *
 * | 调用点               | backdrop 关 | Esc 关 | 遮罩     | 面板          |
 * |----------------------|------------|--------|----------|---------------|
 * | chat.tsx 关闭确认    | ✗          | ✗      | black/50 | max-w-sm      |
 * | knowledge.tsx 编辑   | ✗          | ✗      | black/40 | Card 直挂     |
 * | KbPicker             | ✓          | ✗      | black/50 | max-w-lg      |
 * | RejectReasonDialog   | ✓          | (输入框内)✗ | black/40 | max-w-md      |
 * | NewPatientDialog     | ✓          | ✗      | black/40 | max-w-md      |
 * | SkillCapturePrompt   | ✗          | ✗      | black/50 | max-w-lg      |
 *
 * research-detail.tsx(入组弹窗,#921 wave)已换用;TODO(#922): writing-editor/dialogs.tsx
 * 仍有同类手写弹窗,归属其他 wave/agent。
 */
export interface ModalProps {
  open: boolean;
  onClose?: () => void;
  /** 点击遮罩空白处关闭(仅命中 backdrop 自身,面板内点击不触发)。 */
  backdropClose?: boolean;
  /** 按 Esc 关闭(全局 keydown,open 时挂载)。 */
  escClose?: boolean;
  /** 遮罩定位/层级(默认 z-50 — 现有各处均为 z-50)。 */
  zIndex?: string;
  /** 遮罩附加类(调暗程度/内边距,如 bg-black/40 p-4)。 */
  backdropClassName?: string;
  /** 面板容器类(宽度/圆角/内边距)。缺省 = 不包面板 div,children 直接作为 flex 子元素(如 Card 直挂)。 */
  panelClassName?: string;
  /** 点击遮罩/面板时阻止冒泡外的附加 aria 属性。 */
  role?: string;
  'aria-label'?: string;
  children: ReactNode;
}

export function Modal({
  open,
  onClose,
  backdropClose = false,
  escClose = false,
  zIndex = 'z-50',
  backdropClassName,
  panelClassName,
  role = 'dialog',
  'aria-label': ariaLabel,
  children,
}: ModalProps) {
  useEffect(() => {
    if (!open || !escClose || !onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, escClose, onClose]);

  if (!open) return null;

  return (
    <div
      role={role}
      aria-modal="true"
      aria-label={ariaLabel}
      className={cn('fixed inset-0 flex items-center justify-center', zIndex, backdropClassName)}
      onClick={backdropClose && onClose
        ? (e) => { if (e.target === e.currentTarget) onClose(); }
        : undefined}
    >
      {panelClassName !== undefined ? (
        <div className={panelClassName}>{children}</div>
      ) : (
        children
      )}
    </div>
  );
}
