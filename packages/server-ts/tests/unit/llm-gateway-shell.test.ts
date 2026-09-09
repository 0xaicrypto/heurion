import { test, expect } from 'vitest'
import * as mod from '../../src/common/llm-gateway.js'

/**
 * #921 — re-export 壳完整性:llm-gateway.ts 拆分为目录后,原单体的全部
 * 运行时导出仍可从原路径取得(类型导出由 tsc --noEmit 保证,此处校验值)。
 * #925 — DEEPSEEK_CHAT_MODEL/DEEPSEEK_PREMIUM_MODEL 快照 const 改为惰性
 * 读取函数(resolveLegacyChatModel/resolveLegacyPremiumModel)。
 */
test('#921 shell covers every pre-split runtime export', () => {
  const expected = [
    'FRIENDLY_LLM_ERROR',
    'LlmTruncatedError',
    'resolveDefaultMaxTokens',
    'isImageUnsupportedError',
    'stripImageParts',
    'modelSupportsVision',
    'providerSupportsVision',
    'isMainModelMultimodal',
    'extractImagesFromChatResponse',
    'resolveTierModel',
    'setGlobalModelOverride',
    'getGlobalModelOverride',
    'resolveActiveModel',
    'serializeContent',
    'LLM_PROVIDERS',
    'currentLlmProvider',
    'resolveLlmEndpoint',
    'fetchWithRetry',
    'resolveTurnTimeoutMs',
    'setLlmTelemetryService',
    'getLlmGateway',
    'setLlmGatewayForTest',
  ]
  expect(expected.filter((k) => !(k in mod))).toEqual([])
})

test('#925 — 模型 env 惰性读取生效(运行时改 env 即生效)', () => {
  const saved = process.env.DEEPSEEK_PREMIUM_MODEL
  try {
    delete process.env.DEEPSEEK_PREMIUM_MODEL
    expect(mod.resolveLegacyPremiumModel()).toBe('deepseek-v4-flash')
    process.env.DEEPSEEK_PREMIUM_MODEL = 'glm-5.3'
    expect(mod.resolveLegacyPremiumModel()).toBe('glm-5.3')
  } finally {
    if (saved === undefined) delete process.env.DEEPSEEK_PREMIUM_MODEL
    else process.env.DEEPSEEK_PREMIUM_MODEL = saved
  }
})
