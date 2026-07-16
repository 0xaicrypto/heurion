import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, FileText } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { Alert, Button, Card, Skeleton } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';

interface DocDetail {
  id: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export function WritingEditorPage() {
  const { docId } = useParams<{ docId: string }>();
  const navigate = useNavigate();
  const [doc, setDoc] = useState<DocDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!docId) return;
    setLoading(true);
    setError(null);
    api.getDoc(docId)
      .then(setDoc)
      .catch((err) => setError(err instanceof ApiError ? err.messageText : String(err)))
      .finally(() => setLoading(false));
  }, [docId]);

  if (loading) {
    return (
      <AppShell>
        <div className="flex h-full flex-col">
          <div className="flex h-14 items-center border-b border-border bg-surface px-6 gap-3">
            <Skeleton className="h-5 w-5" />
            <Skeleton className="h-5 w-48" />
          </div>
          <div className="p-6 space-y-4">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-64 w-full rounded-xl" />
          </div>
        </div>
      </AppShell>
    );
  }

  if (error) {
    return (
      <AppShell>
        <div className="flex h-full flex-col">
          <div className="flex h-14 items-center border-b border-border bg-surface px-6">
            <Button variant="ghost" size="sm" onClick={() => navigate('/app/writing')}>
              <ArrowLeft size={16} className="mr-1" /> Back
            </Button>
          </div>
          <div className="p-6">
            <Alert variant="error">{error}</Alert>
          </div>
        </div>
      </AppShell>
    );
  }

  if (!doc) {
    return (
      <AppShell>
        <div className="flex h-full flex-col">
          <div className="flex h-14 items-center border-b border-border bg-surface px-6">
            <Button variant="ghost" size="sm" onClick={() => navigate('/app/writing')}>
              <ArrowLeft size={16} className="mr-1" /> Back
            </Button>
          </div>
          <div className="flex flex-1 items-center justify-center">
            <p className="text-text-tertiary">Document not found</p>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto">
        <header className="flex h-14 items-center gap-3 border-b border-border bg-surface px-6">
          <Button variant="ghost" size="sm" onClick={() => navigate('/app/writing')}>
            <ArrowLeft size={16} />
          </Button>
          <FileText size={18} className="text-text-tertiary" />
          <h1 className="font-semibold text-text-primary">{doc.title || 'Untitled'}</h1>
        </header>

        <main className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-3xl space-y-4">
            <Card className="p-6">
              <div className="mb-4 text-xs text-text-tertiary">
                Created: {new Date(doc.created_at).toLocaleDateString()}
                {doc.updated_at !== doc.created_at ? ` · Updated: ${new Date(doc.updated_at).toLocaleDateString()}` : ''}
              </div>
              {doc.body ? (
                <div className="prose prose-sm max-w-none text-text-primary whitespace-pre-wrap">
                  {doc.body}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <FileText size={32} className="mb-2 text-text-tertiary" />
                  <p className="text-text-tertiary">This document is empty</p>
                </div>
              )}
            </Card>
          </div>
        </main>
      </div>
    </AppShell>
  );
}
