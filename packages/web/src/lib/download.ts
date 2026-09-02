/**
 * #653 — shared blob download helper. The trigger-a-click pattern was
 * hand-rolled in writing.ts / submission.tsx (and viewer.tsx builds object
 * URLs separately for <img>, which is a different use case).
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
