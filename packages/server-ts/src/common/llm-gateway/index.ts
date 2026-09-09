/**
 * #921 — llm-gateway 拆分 barrel。
 *
 * 目录结构(全部自 src/common/llm-gateway.ts 单体机械搬移,零行为变化):
 *   types.ts     共享类型/错误/遥测口
 *   provider.ts  provider 注册表/模型解析/输出预算(+ #925 模型 env 惰性读取)
 *   http.ts      fetch 超时重试/请求头/body 空闲超时
 *   pricing.ts   计价/用量/失败遥测(LLM_PRICING 坏 JSON warn-once 回退)
 *   vision.ts    视觉能力判定/多模态序列化/图片剥离(+ #925 env 惰性读取)
 *   streaming.ts chatWithToolsStream / stream 实现(SSE 解析/截断重试)
 *   gateway.ts   LlmGateway 接口 + OpenAICompatibleLlmGateway + 进程级单例
 *
 * src/common/llm-gateway.ts 是本模块的纯 re-export 壳 — 全仓既有
 * `from '.../common/llm-gateway.js'` import 路径零改动可用。
 */
export * from './types.js'
export * from './provider.js'
export * from './http.js'
export * from './pricing.js'
export * from './vision.js'
export * from './streaming.js'
export * from './gateway.js'
