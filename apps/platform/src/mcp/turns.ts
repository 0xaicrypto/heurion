/**
 * 进行中的回合登记：MCP 写入按用户找到当前回合，打上 turn_id（撤销单元、版本快照、事件归属）。
 * 每个用户同一时间只有一个 dsh 回合（一个用户一个 dsh 进程）。
 */

export type TurnNotice = { type: 'comment_reply'; doc_id: string; comment_id: string }

export interface ActiveTurn {
  turnId: string
  /** 本回合写过的文档。 */
  touched: Set<string>
  notify: (n: TurnNotice) => void
}

export class TurnRegistry {
  private readonly turns = new Map<string, ActiveTurn>()

  begin(userId: string, turn: ActiveTurn): void {
    this.turns.set(userId, turn)
  }

  end(userId: string, turnId: string): void {
    if (this.turns.get(userId)?.turnId === turnId) this.turns.delete(userId)
  }

  active(userId: string): ActiveTurn | undefined {
    return this.turns.get(userId)
  }

  touch(userId: string, docId: string): void {
    this.turns.get(userId)?.touched.add(docId)
  }

  notify(userId: string, notice: TurnNotice): void {
    this.turns.get(userId)?.notify(notice)
  }
}
