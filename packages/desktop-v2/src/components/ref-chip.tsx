/**
 * ref-chip — TipTap inline atom node for Writing Studio ``{{ref:ID}}``
 * reference tokens (P2 editor upgrade).
 *
 * The node is an ATOM: one cursor unit, one backspace deletes the whole
 * chip, ⌘Z restores it (starter-kit undoRedo). It carries only the
 * ``refId`` attribute — everything displayed (chip label, snapshot
 * preview, patient/study tint) is looked up from the document's
 * references list via ``RefChipContext``, so chips re-render when the
 * list loads without touching the ProseMirror doc.
 *
 * Serialization: the chip's canonical form is its token. That mapping
 * lives in three places, kept in lockstep:
 *   * writing-doc-serial.ts   (string ⇄ doc, pure, unit-tested)
 *   * ``renderText``          (editor.getText())
 *   * ``refChipLeafText``     (doc.textBetween leaf — selection offsets)
 *
 * Visuals reuse the right-rail chip language: pill, ◇ label, accent
 * border (green tint for study refs) + a lightweight absolutely-
 * positioned hover tooltip (no popover dep) showing the de-identified
 * snapshot preview and the 已脱敏 hint.
 */
import { createContext, useContext, useState, type ReactNode } from 'react';
import {
  mergeAttributes,
  Node as TipTapNode,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from '@tiptap/react';
import type { WritingReference } from '../lib/api-client';
import { cn } from '../lib/util';
import { useT } from '../lib/i18n';

type PMNode = NodeViewProps['node'];

/** Canonical wire token for a chip node — MUST match
 *  writing-doc-serial.ts's serializer. */
export function refChipToken(refId: string): string {
  return `{{ref:${refId}}}`;
}

/** ``leafText`` for ``doc.textBetween`` so selection offsets and
 *  extracted text map 1:1 onto the serialized body string. */
export function refChipLeafText(node: PMNode): string {
  return node.type.name === 'refChip'
    ? refChipToken(String(node.attrs.refId ?? ''))
    : '';
}

/* ── ref-map context ──────────────────────────────────────────── */

const RefChipContext = createContext<ReadonlyMap<string, WritingReference>>(new Map());

/** Wrap ``EditorContent`` with this so chip node views (rendered via
 *  React portals INSIDE EditorContent) can resolve refId → reference. */
export function RefChipProvider({
  references, children,
}: {
  references: WritingReference[];
  children: ReactNode;
}) {
  return (
    <RefChipContext.Provider value={new Map(references.map((r) => [r.refId, r]))}>
      {children}
    </RefChipContext.Provider>
  );
}

/* ── node view ────────────────────────────────────────────────── */

function RefChipView({ node, selected }: NodeViewProps) {
  const t = useT();
  const refs = useContext(RefChipContext);
  const [hover, setHover] = useState(false);
  const refId = String(node.attrs.refId ?? '');
  const ref = refs.get(refId);
  return (
    <NodeViewWrapper
      as="span"
      className="relative inline-block align-baseline"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span
        data-ref-chip={refId}
        className={cn(
          'mx-0.5 inline-flex cursor-default select-none items-center gap-1',
          'whitespace-nowrap rounded-full border px-2 py-0.5 align-baseline text-[12px]',
          ref?.refType === 'study'
            ? 'border-rw-green bg-rw-green-bg text-rw-green'
            : 'border-rw-accent-bd bg-rw-accent-bg text-rw-accent',
          selected && 'ring-2 ring-rw-accent-bd',
        )}
      >
        ◇ {ref?.chipLabel ?? refId}
      </span>
      {hover && (
        <span
          className="absolute bottom-full left-0 z-50 mb-1.5 block w-max max-w-[300px]
                     rounded-md border border-rw-border bg-rw-bg-deep px-3 py-2 shadow-lg"
          contentEditable={false}
        >
          <span className="block text-[11px] font-medium text-rw-green">
            ✓ {t('writing.chip.deidentified')}
          </span>
          <span className="mt-1 block whitespace-pre-wrap text-[11px] leading-4 text-rw-t3">
            {ref?.snapshotPreview || refChipToken(refId)}
          </span>
        </span>
      )}
    </NodeViewWrapper>
  );
}

/* ── the extension ────────────────────────────────────────────── */

export const RefChip = TipTapNode.create({
  name: 'refChip',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      refId: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-ref-chip') ?? '',
        renderHTML: (attrs) => ({ 'data-ref-chip': String(attrs.refId ?? '') }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-ref-chip]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    // Fallback rendering (clipboard HTML etc.) — the live editor uses
    // the React node view. Text content = the wire token so copying a
    // chip into any plain-text target degrades gracefully.
    return [
      'span',
      mergeAttributes(HTMLAttributes),
      refChipToken(String(node.attrs.refId ?? '')),
    ];
  },

  renderText({ node }) {
    return refChipToken(String(node.attrs.refId ?? ''));
  },

  addNodeView() {
    return ReactNodeViewRenderer(RefChipView);
  },
});
