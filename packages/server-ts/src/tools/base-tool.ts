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

  abstract execute(args: Record<string, unknown>): Promise<ToolResult>
}
