import fs from 'fs'
import path from 'path'
import { VersionedStore } from '../core/versioned-store'
import type { MemoryNode, MemoryRelation, MemoryGraphState, MemoryNodeType } from './memory.types'

export class MemoryGraph {
  private store: VersionedStore
  private nodes: Map<string, MemoryNode> = new Map()
  /** §5.6 (#199): stableId → latest version — avoids an O(N) scan per lookup. */
  private latestByStableId: Map<string, MemoryNode> = new Map()
  private relations: MemoryRelation[] = []

  constructor(baseDir: string) {
    const dir = path.join(baseDir, 'memory_graph')
    fs.mkdirSync(dir, { recursive: true })
    this.store = new VersionedStore(dir)
    this.load()
  }

  private load() {
    const current = this.store.current() as MemoryGraphState | null
    if (!current) return
    if (Array.isArray(current.nodes)) {
      for (const node of current.nodes) {
        this.nodes.set(node.id, node)
        this.indexNode(node)
      }
    }
    if (Array.isArray(current.relations)) {
      this.relations = current.relations
    }
  }

  /** Re-read the last committed state from disk (dual-store rollback, #192). */
  reload(): void {
    this.nodes.clear()
    this.latestByStableId.clear()
    this.relations = []
    this.load()
  }

  commit(): string {
    const state: MemoryGraphState = {
      nodes: Array.from(this.nodes.values()),
      relations: this.relations,
    }
    return this.store.propose(state)
  }

  currentVersion(): string | null {
    return this.store.currentVersion()
  }

  get nodeCount() {
    return this.nodes.size
  }

  get relationCount() {
    return this.relations.length
  }

  addNode(node: MemoryNode) {
    this.nodes.set(node.id, node)
    this.indexNode(node)
  }

  private indexNode(node: MemoryNode): void {
    const existing = this.latestByStableId.get(node.stableId)
    if (!existing || node.version > existing.version) {
      this.latestByStableId.set(node.stableId, node)
    }
  }

  getNode(id: string): MemoryNode | undefined {
    return this.nodes.get(id)
  }

  getNodesByType(type: MemoryNodeType): MemoryNode[] {
    return Array.from(this.nodes.values()).filter(n => n.type === type)
  }

  getCurrentNodesByType(type: MemoryNodeType): MemoryNode[] {
    return this.getNodesByType(type).filter(n => n.status !== 'superseded')
  }

  getAllNodes(): MemoryNode[] {
    return Array.from(this.nodes.values())
  }

  getAllRelations(): MemoryRelation[] {
    return [...this.relations]
  }

  getCurrentNodes(): MemoryNode[] {
    return Array.from(this.nodes.values()).filter(n => n.status !== 'superseded')
  }

  /** Returns the latest version of a node by stableId, preferring current/stale over superseded. */
  getLatestByStableId(stableId: string): MemoryNode | undefined {
    const latest = this.latestByStableId.get(stableId)
    if (!latest) return undefined
    // Prefer the newest non-superseded version when the latest is superseded
    // (edit paths keep the newest node current, but supersede chains exist).
    if (latest.status !== 'superseded') return latest
    const versions = Array.from(this.nodes.values())
      .filter(n => n.stableId === stableId)
      .sort((a, b) => b.version - a.version)
    return versions.find(n => n.status !== 'superseded') ?? latest
  }

  /** Returns all versions for a stableId, newest first. */
  getVersions(stableId: string): MemoryNode[] {
    return Array.from(this.nodes.values())
      .filter(n => n.stableId === stableId)
      .sort((a, b) => b.version - a.version)
  }

  updateNode(id: string, patch: Partial<MemoryNode>): MemoryNode | undefined {
    const node = this.nodes.get(id)
    if (!node) return undefined
    const updated = { ...node, ...patch, updatedAt: Date.now() } as MemoryNode
    this.nodes.set(id, updated)
    // §5.6 (#199): keep the stableId index pointing at the freshest object.
    const latest = this.latestByStableId.get(node.stableId)
    if (!latest || latest.id === id || node.version >= latest.version) {
      this.latestByStableId.set(node.stableId, updated)
    }
    return updated
  }

  markStatus(id: string, status: MemoryNode['status']): MemoryNode | undefined {
    return this.updateNode(id, { status })
  }

  addRelation(relation: MemoryRelation) {
    // Avoid exact duplicates
    const exists = this.relations.some(
      r =>
        r.sourceId === relation.sourceId &&
        r.targetId === relation.targetId &&
        r.relation === relation.relation,
    )
    if (!exists) {
      this.relations.push(relation)
    }
  }

  removeRelation(sourceId: string, targetId: string, relation: MemoryRelation['relation']) {
    this.relations = this.relations.filter(
      r => !(r.sourceId === sourceId && r.targetId === targetId && r.relation === relation),
    )
  }

  getRelationsFrom(sourceId: string): MemoryRelation[] {
    return this.relations.filter(r => r.sourceId === sourceId)
  }

  getRelationsTo(targetId: string): MemoryRelation[] {
    return this.relations.filter(r => r.targetId === targetId)
  }

  /** Find node IDs that have a `depends_on` relation pointing to targetId. */
  getDependents(targetId: string): string[] {
    return this.relations
      .filter(r => r.targetId === targetId && r.relation === 'depends_on')
      .map(r => r.sourceId)
  }

  /** Find node IDs that targetId derives_from. */
  getSources(sourceId: string): string[] {
    return this.relations
      .filter(r => r.sourceId === sourceId && r.relation === 'derives_from')
      .map(r => r.targetId)
  }

  snapshot(): MemoryGraphState {
    return {
      nodes: Array.from(this.nodes.values()),
      relations: [...this.relations],
    }
  }

  /** Replace state directly — used by import/replay. */
  restore(state: MemoryGraphState) {
    this.nodes.clear()
    for (const node of state.nodes) {
      this.nodes.set(node.id, node)
    }
    this.relations = state.relations ? [...state.relations] : []
  }
}
