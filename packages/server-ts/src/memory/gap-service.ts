/**
 * Gap-node service (#682) — the gap group of the former MemoryService.
 */
import { ok, err, type Result } from '../common/result'
import { isNodeSuperseded } from './memory.types.js'
import { MemoryNodeService, hashContent, newStableId, newNodeId, type MemoryCollaborators } from './node-base.js'
import type { AddGapInput, GapNode, MemoryNode, MemoryCreatedBy } from './memory.types'

export class GapService extends MemoryNodeService {
  constructor(c: MemoryCollaborators) {
    super(c)
  }

  addGap(input: AddGapInput, createdBy: MemoryCreatedBy = 'system'): GapNode {
    const now = Date.now()
    const stableId = newStableId('gap')
    const version = 1
    const nodeId = newNodeId(stableId, version)

    const gap: GapNode = {
      id: nodeId,
      stableId,
      type: 'gap',
      ownerId: this.c.ownerId,
      status: 'current',
      content: input.query,
      contentHash: hashContent(input.query),
      version,
      query: input.query,
      context: input.context,
      source: input.source,
      sourceId: input.sourceId,
      createdAt: now,
      updatedAt: now,
      createdBy,
      provenance: {
        sourceKind: input.provenance?.sourceKind || (createdBy === 'user' ? 'user' : 'system'),
        ...input.provenance,
      },
      meta: {},
    }

    this.c.graph.addNode(gap)
    this.c.graph.commit()

    this.appendEvent('memory_gap_detected', `Detected gap ${stableId}`, { gapId: stableId, nodeId })
    return gap
  }

  answerGap(gapStableId: string, answerNode: MemoryNode, answeredBy: MemoryCreatedBy = 'user'): Result<GapNode> {
    const gap = this.c.graph.getLatestByStableId(gapStableId) as GapNode | undefined
    if (!gap || isNodeSuperseded(gap)) return err('gap not found or superseded')

    this.c.graph.updateNode(gap.id, {
      status: 'current',
      answerNodeId: answerNode.stableId,
    } as Partial<GapNode>)
    this.c.graph.addRelation({
      id: newStableId('rel'),
      sourceId: gap.id,
      targetId: answerNode.id,
      relation: 'answers',
      createdAt: Date.now(),
    })
    this.c.graph.commit()

    this.appendEvent('memory_gap_answered', `Answered gap ${gapStableId}`, {
      gapId: gapStableId,
      answerNodeId: answerNode.stableId,
    })
    return ok(this.c.graph.getNode(gap.id) as GapNode)
  }
}
