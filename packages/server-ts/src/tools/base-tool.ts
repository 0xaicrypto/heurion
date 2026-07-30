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
}

export abstract class BaseTool {
  abstract get name(): string
  abstract get description(): string
  abstract get parameters(): Record<string, unknown>

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
