export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ToolResult {
  success: boolean
  output?: string
  error?: string
  /** T1: output was truncated (head+tail); full content saved to disk. */
  truncated?: boolean
  fullOutputPath?: string | null
}

export abstract class BaseTool {
  abstract get name(): string
  abstract get description(): string
  abstract get parameters(): Record<string, unknown>

  /**
   * #828: per-tool registry timeout ceiling (ms). undefined → the registry
   * default (TOOL_TIMEOUT_MS env or 120s) applies. Long-running tools
   * (delegate / spawn_subagent / execution-plane renders) override with a
   * larger budget so the registry wrapper never kills legitimate work —
   * the wrapper is a hang backstop, not a perf budget.
   */
  get timeoutMs(): number | undefined {
    return undefined
  }

  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters,
      },
    }
  }

  /**
   * #1103: optional abort signal threaded from the registry guard — it fires
   * when this tool's timeout ceiling is hit or the turn is aborted. Tools
   * should check `signal.aborted` at their write/commit points; existing
   * tools that ignore it keep working (backwards compatible).
   */
  abstract execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>
}

/** #1103: clean failure for write-class tools that observe an aborted signal at their write point. */
export const ABORTED_WRITE_ERROR = '已超时中止，本次修改未写入'

/**
 * #1103: write-class tools call this right before every durable write
 * (writeDocVersion / putDeckArtifact). Returns the failure result when the
 * execution was aborted (timeout / turn abort) — a late write after the
 * caller already received "timeout" is exactly the duplicate/overwrite risk
 * this guard closes. Null ⇒ not aborted, proceed with the write.
 */
export function abortedWriteResult(signal: AbortSignal | undefined | null): ToolResult | null {
  return signal?.aborted ? { success: false, error: ABORTED_WRITE_ERROR } : null
}
