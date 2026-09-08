/**
 * #436 — LlmGateway: the SINGLE entry point for LLM calls (Strategy + DIP).
 * #921 — god file 拆分:实现已移至 ./llm-gateway/ 目录(types/provider/http/
 * pricing/vision/streaming/gateway,index.ts 为 barrel)。本文件只保留
 * re-export 壳,全仓既有 import 路径(./llm-gateway.js)零改动可用。
 */
export * from './llm-gateway/index.js'
