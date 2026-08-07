import { useState } from 'react';
import { X } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import type { ChatSession } from '@/lib/types';
import { Button, Input } from '@/components/ui';

interface NewSessionDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (session: ChatSession) => void;
}

export function NewSessionDialog({ open, onClose, onCreated }: NewSessionDialogProps) {
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = title.trim();
    setLoading(true);
    setError(null);
    try {
      const session = await api.createSession(name || 'New Session', { scope: 'global' });
      setTitle('');
      setLoading(false);
      onClose();
      onCreated(session);
    } catch (err) {
      setError(err instanceof ApiError ? err.messageText : 'Failed to create session');
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-xl border border-border bg-surface p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary">新建会话</h2>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <Input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="会话名称（可选，默认 New Session）"
            maxLength={60}
            className="h-9"
          />
          {error && <div className="text-xs text-error">{error}</div>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={loading}>
              取消
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? '创建中…' : '创建'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
