/**
 * #1146 — ToolRegistry 晚绑定端口（叶子模块）。
 * subagent-runner 需要构造工具注册表，但直接 import tool-registry 会与
 * tool-registry → subagent-tools → subagent-runner 形成环。tool-registry
 * 在模块加载时注册工厂，runner 只经本叶子模块取实例。
 */

/** runner 实际使用的最小面（get/execute）— 与 ToolRegistry 结构兼容。 */
export interface RegistryLike {
  get(name: string): unknown
  execute(name: string, args: Record<string, unknown>): Promise<{ success: boolean; output?: string; error?: string }>
}

let factory: ((ctx: unknown) => RegistryLike) | null = null

/** tool-registry 模块加载时调用（唯一注册点）。 */
export function registerToolRegistryFactory(fn: (ctx: unknown) => RegistryLike): void {
  factory = fn
}

export function createToolRegistry(ctx: unknown): RegistryLike {
  if (!factory) {
    throw new Error('tool registry factory not registered — tool-registry module was not loaded')
  }
  return factory(ctx)
}
