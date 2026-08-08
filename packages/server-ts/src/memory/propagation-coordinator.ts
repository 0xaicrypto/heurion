/**
 * #304: write-order coordinator — 修改 → legacy 传播 → graph 最后 commit。
 * The graph is the last store to commit: legacy commits are provisional and
 * compensated with a rollback when the graph commit fails, so the two stores
 * can never diverge on disk (#192/#231). Testable in isolation.
 */
import type { MemoryGraph } from './memory.graph.js'
import { LegacyProjection, type LegacySnapshot } from './legacy-projection.js'

export class PropagationCoordinator {
  constructor(
    private legacy: LegacyProjection,
    private graph: MemoryGraph,
  ) {}

  /** Take the pre-mutation snapshot — call before mutating stores. */
  begin(): LegacySnapshot {
    return this.legacy.snapshot()
  }

  /**
   * Commit the write: legacy stores must already be committed by the
   * mutation; the graph commits last. On graph failure the legacy stores
   * are rolled back to the snapshot and the error rethrown.
   */
  commit(snapshot: LegacySnapshot): void {
    try {
      this.graph.commit()
    } catch (e) {
      this.legacy.rollback(snapshot)
      throw e
    }
  }
}
