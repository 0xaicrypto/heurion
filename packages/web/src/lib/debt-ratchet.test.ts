import { describe, test, expect } from 'vitest'

/**
 * P2 技术债棘轮 (web) — 冻结当前债务水位,只允许下降:
 *  - >500 行源文件(不含测试)精确体积上限;
 *  - `.catch(() => {})` 吞错计数上限。
 * 用 import.meta.glob(?raw) 取源码,避免 node types(web tsc 无 @types/node)。
 * 改大文件中任意一个后,请先拆分再同步此表。
 */
const RAW = import.meta.glob('../**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

const LARGE_FILE_CAPS: Record<string, number> = {
  'routes/writing-editor.tsx': 1369,
  'components/DocEditor.tsx': 1034,
  'routes/chat.tsx': 958,
  'routes/knowledge.tsx': 904,
  'routes/submission.tsx': 888,
  'routes/landing.tsx': 794,
  'routes/patients.tsx': 792,
  'routes/settings.tsx': 763,
  'routes/writing-editor/deck-rich-editor.tsx': 699,
  'components/brain/IngestionInbox.tsx': 652,
  'lib/comment-anchor.ts': 638,
  'stores/chat.ts': 600,
  'lib/chat-reducer.ts': 589,
  'lib/types.ts': 568,
  'routes/writing-editor/comments-ai.ts': 559,
}
const MAX_EMPTY_CATCH = 26

/** glob key(相对本文件,如 '../components/x.tsx' / './sibling.ts')→ src 相对路径。 */
function relPath(key: string): string {
  if (key.startsWith('./')) return `lib/${key.slice(2)}`
  return key.replace(/^\.\.\//, '')
}

function lineCount(content: string): number {
  return content.endsWith('\n') ? content.split('\n').length - 1 : content.split('\n').length
}

describe('P2 债务棘轮 (web src)', () => {
  const entries = Object.entries(RAW).filter(([k]) => !/\.test\.(ts|tsx)$/.test(k))

  test('>500 行源文件不得超过冻结体积,且不得新增超限文件', () => {
    const offenders: string[] = []
    for (const [key, content] of entries) {
      const rel = relPath(key)
      const lines = lineCount(content)
      const cap = LARGE_FILE_CAPS[rel]
      if (cap !== undefined) {
        if (lines > cap) offenders.push(`${rel}: ${lines} > cap ${cap}(需拆分后再同步基线)`)
      } else if (lines > 500) {
        offenders.push(`${rel}: ${lines} 行(新增大文件 — 请拆分或补基线并说明)`)
      }
    }
    expect(offenders, `大文件债务增长:\n${offenders.join('\n')}`).toEqual([])
  })

  test('吞错 `.catch(() => {})` 计数不增长', () => {
    let count = 0
    for (const [, content] of entries) {
      count += (content.match(/\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g) || []).length
    }
    expect(count, '空 catch 吞错新增 — 至少写日志/注释说明为何安全').toBeLessThanOrEqual(MAX_EMPTY_CATCH)
  })
})
