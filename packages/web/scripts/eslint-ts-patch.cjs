/**
 * ESLint 启动垫片 — 让 typescript-eslint 工具链拿到完整 TS 编译器 API。
 *
 * 背景(#953): packages/server-ts 的 "typescript" 依赖是 7.x(tsgo 原生移植
 * 预览),它没有 JS compiler API(ts.SyntaxKind 都不存在);typescript-eslint
 * 的 parser/plugin 依赖 require('typescript') 做 AST 工作,直接用会崩
 * ("Cannot read properties of undefined (reading 'Intrinsic')")。
 *
 * 处理:lint 进程启动时把 'typescript' 的解析重定向到 typescript-lint
 * (devDependency 别名 = 经典 TS 5.9)。仅影响 eslint 进程;构建/测试仍用
 * tsgo,行为不变。tsgo 稳定、typescript-eslint 支持后再撤掉本垫片。
 */
const Module = require('module')

const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'typescript') {
    try {
      return require.resolve('typescript-lint')
    } catch {
      // 别名缺失时退回默认解析(让原始报错可见)
    }
  }
  return originalResolve.call(this, request, ...rest)
}
