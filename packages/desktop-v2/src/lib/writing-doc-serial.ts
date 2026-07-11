/**
 * writing-doc-serial — bidirectional serialization between the Writing
 * Studio's wire format (a plain string whose only structure is '\n'
 * paragraph breaks and inline ``{{ref:ID}}`` reference tokens) and the
 * TipTap/ProseMirror JSON document shape.
 *
 * The server contract is the STRING — PUT /docs/{id} {body} — so these
 * functions are the single source of truth for what the editor doc
 * "means". They are deliberately pure (no TipTap/ProseMirror imports)
 * so they can be unit-tested headless in node
 * (scripts/test-writing-doc-serial.mjs) and reused by the editor:
 *
 *   string → doc   parseBodyToDoc()      hydrate the editor (setContent)
 *   doc → string   serializeDocToBody()  every editor update → draft.body
 *
 * Invariants (proved by the round-trip test):
 *   * serializeDocToBody(parseBodyToDoc(s)) === s   for every string s
 *   * newline count === paragraph count − 1 (empty body = 1 empty ¶)
 *   * a refChip atom serializes to exactly its ``{{ref:ID}}`` token
 *
 * NOTE the doc shape here is the SUBSET the editor is allowed to
 * produce: paragraphs containing text + refChip only. No marks are
 * serialized — starter-kit marks (bold/italic/…) are disabled in the
 * editor (see writing-studio.tsx) precisely so nothing unserializable
 * can enter the document.
 */

export const REF_TOKEN_RE = /\{\{ref:([^}]+)\}\}/g;

/* ── doc shape (structural subset of ProseMirror JSON) ────────── */

export interface SerialTextNode { type: 'text'; text: string }
export interface SerialRefChipNode { type: 'refChip'; attrs: { refId: string } }
export type SerialInlineNode = SerialTextNode | SerialRefChipNode;
export interface SerialParagraphNode {
  type: 'paragraph';
  content?: SerialInlineNode[];
}
export interface SerialDocNode { type: 'doc'; content: SerialParagraphNode[] }

/* ── string → doc ─────────────────────────────────────────────── */

/** One body LINE → inline nodes: text runs + refChip atoms. Empty
 *  lines produce ``[]`` (ProseMirror forbids empty text nodes, so an
 *  empty paragraph simply has no ``content``). */
export function parseLineToInline(line: string): SerialInlineNode[] {
  const out: SerialInlineNode[] = [];
  let last = 0;
  REF_TOKEN_RE.lastIndex = 0;
  for (let m = REF_TOKEN_RE.exec(line); m; m = REF_TOKEN_RE.exec(line)) {
    if (m.index > last) out.push({ type: 'text', text: line.slice(last, m.index) });
    out.push({ type: 'refChip', attrs: { refId: m[1] } });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ type: 'text', text: line.slice(last) });
  return out;
}

/** Wire string → editor doc. '\n' = paragraph break, so a trailing
 *  newline yields a trailing empty paragraph (and round-trips). */
export function parseBodyToDoc(body: string): SerialDocNode {
  return {
    type: 'doc',
    content: body.split('\n').map((line): SerialParagraphNode => {
      const content = parseLineToInline(line);
      return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
    }),
  };
}

/* ── doc → string ─────────────────────────────────────────────── */

function serializeInline(node: SerialInlineNode): string {
  if (node.type === 'refChip') return `{{ref:${node.attrs?.refId ?? ''}}}`;
  return node.text ?? '';
}

/** Editor doc → wire string. Tolerant of ``content: undefined``
 *  (ProseMirror's ``toJSON()`` omits it for empty paragraphs) and of
 *  unknown inline node types (serialized as '' rather than throwing —
 *  nothing else should exist, but a silent drop beats a lost draft). */
export function serializeDocToBody(doc: SerialDocNode): string {
  return (doc.content ?? [])
    .map((p) => (p.content ?? []).map(serializeInline).join(''))
    .join('\n');
}
