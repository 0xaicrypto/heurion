/**
 * #382: writing ↔ submission linkage — the paper is ONE object shared by
 * the Write tab (Doc) and the Submission tab (SubmissionDraft). This module
 * keeps the lightweight cross-tab link (which doc the submission came from)
 * in localStorage so a refresh never loses the connection.
 */
const KEY = 'nexus.paper.link';

export interface PaperLink {
  docId?: string;
  title: string;
  abstract: string;
  updatedAt: number;
}

export function getPaperLink(): PaperLink | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PaperLink;
    if (!parsed.title) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function setPaperLink(link: PaperLink): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...link, updatedAt: Date.now() }));
  } catch {
    /* storage unavailable */
  }
}

export function clearPaperLink(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
