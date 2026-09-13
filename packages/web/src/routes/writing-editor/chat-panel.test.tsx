import { describe, test, expect, vi } from 'vitest';
import { render } from '@/test/render';
import { screen, fireEvent } from '@testing-library/react';
import { ChatPanel } from './chat-panel';
import type { DocChat } from './doc-chat';

/** #1032: doc-chat 附件「固定为引用」按钮（与主 chat 对称）。 */

function makeChat(overrides: Partial<DocChat> = {}): DocChat {
  return {
    chatInput: '',
    setChatInput: vi.fn(),
    chatSelection: '',
    setChatSelection: vi.fn(),
    chatSession: undefined,
    chatMessages: [],
    chatLoading: false,
    chatPending: false,
    chatEndRef: { current: null },
    chatFileRef: { current: null },
    activeSkills: [],
    setActiveSkills: vi.fn(),
    chatUploadingFile: false,
    uploadState: null,
    setUploadState: vi.fn(),
    kbDedupNotice: null,
    chatAttachedFiles: [{ name: 'paper.pdf', fileId: 'f1' }],
    stopStream: vi.fn(),
    sendChatText: vi.fn(),
    handleSendChat: vi.fn(),
    handleChatPaste: vi.fn(),
    handleChatFile: vi.fn(),
    handleDocUpload: vi.fn(),
    docUploadRef: { current: null },
    cancelUpload: vi.fn(),
    schedulePptxReload: vi.fn(),
    appendMessage: vi.fn(),
    ...overrides,
  } as unknown as DocChat;
}

const baseProps = {
  chatWidth: 360,
  sidePanelTab: 'chat' as const,
  setSidePanelTab: vi.fn(),
  onClose: vi.fn(),
  onResizeStart: vi.fn(),
  chatSessionId: 'doc-d1',
  onInsertChart: vi.fn(),
  onJumpToSection: vi.fn(),
  attachmentPinning: false,
  onPinAttachment: vi.fn(),
};

describe('#1032 doc-chat 附件固定为引用', () => {
  test('点击附件上的固定按钮回调 file id', () => {
    const onPin = vi.fn();
    render(<ChatPanel {...baseProps} chat={makeChat()} onPinAttachment={onPin} />);
    fireEvent.click(screen.getByRole('button', { name: /固定为引用|Pin as reference/ }));
    expect(onPin).toHaveBeenCalledWith({ name: 'paper.pdf', fileId: 'f1' });
  });

  test('登记中按钮禁用（防双击重复请求）', () => {
    render(<ChatPanel {...baseProps} chat={makeChat()} attachmentPinning />);
    expect(screen.getByRole('button', { name: /固定为引用|Pin as reference/ })).toBeDisabled();
  });
});
