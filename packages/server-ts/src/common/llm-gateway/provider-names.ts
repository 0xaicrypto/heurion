/**
 * #1150-followup — LLM provider 名单单一来源（叶子模块，无依赖）。
 * provider.ts 的 registry 以此为键类型（漏配/多配编译期报错）；
 * env-schema 用它做 DEFAULT_LLM_PROVIDER 校验（大小写不敏感），
 * 避免"名单两处维护、配 kimi/zhipu 启动即被拒"的漂移。
 */
export const LLM_PROVIDER_NAMES = ['deepseek', 'opencode', 'zhipu', 'gemini', 'openai', 'kimi'] as const

export type LlmProviderName = (typeof LLM_PROVIDER_NAMES)[number]
