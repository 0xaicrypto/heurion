/**
 * Document-node service (#682) — the document group of the former
 * MemoryService. Documents are single-version (file uploads); deletion
 * cascades via curation propagation.
 */
import { ok, err, type Result } from '../common/result'
import { isNodeSuperseded } from './memory.types.js'
import { MemoryNodeService, hashContent, newStableId, newNodeId, type MemoryCollaborators } from './node-base.js'
import type { AddDocumentInput, DocumentNode, MemoryCreatedBy } from './memory.types'

export class DocumentService extends MemoryNodeService {
  constructor(c: MemoryCollaborators) {
    super(c)
  }

  addDocument(input: AddDocumentInput, createdBy: MemoryCreatedBy = 'system'): DocumentNode {
    const now = Date.now()
    const stableId = input.fileId || newStableId('doc')
    const version = 1
    const nodeId = newNodeId(stableId, version)

    const doc: DocumentNode = {
      id: nodeId,
      stableId,
      type: 'document',
      ownerId: this.c.ownerId,
      status: 'current',
      content: `${input.name} (${input.mimeType})`,
      contentHash: hashContent(input.sha256),
      version,
      fileId: input.fileId,
      sha256: input.sha256,
      name: input.name,
      mimeType: input.mimeType,
      patientHash: input.patientHash,
      createdAt: now,
      updatedAt: now,
      createdBy,
      provenance: {
        sourceKind: input.provenance?.sourceKind || 'system',
        ...input.provenance,
      },
      meta: {},
    }

    this.c.graph.addNode(doc)
    this.c.graph.commit()

    this.appendEvent('memory_document_uploaded', `Uploaded document ${stableId}`, { documentId: stableId, nodeId })
    return doc
  }

  deleteDocument(stableId: string, deletedBy: MemoryCreatedBy = 'user'): Result<void> {
    const current = this.c.graph.getLatestByStableId(stableId) as DocumentNode | undefined
    if (!current || isNodeSuperseded(current)) return err('document not found or superseded')

    // Snapshot legacy before any provisional write (dual-store atomicity, #192).
    const legacyBefore = this.snapshotLegacy()

    this.c.graph.markStatus(current.id, 'superseded')

    const propagation = this.c.curation.propagateDocumentDelete(stableId)
    this.applyPropagationToLegacy(propagation)

    this.commitGraphLast(legacyBefore)

    // #439: keep derived indexes (embedding vectors) in sync with the graph.
    this.c.onNodeRemoved?.(stableId, 'document')

    this.appendEvent('memory_document_deleted', `Deleted document ${stableId}`, {
      documentId: stableId,
      deletedBy,
      propagation,
    })
    return ok(undefined)
  }
}
