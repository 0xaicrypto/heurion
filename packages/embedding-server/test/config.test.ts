import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePositiveInt } from '../src/config.js'

/**
 * #1149 — batchSize/port 解析：0/负数/NaN 此前进入 embed 循环造成死循环或
 * 空向量 200；必须回退默认值并 warn。
 */
test('parsePositiveInt: 合法值透传', () => {
  assert.equal(parsePositiveInt('32', 16, 'X'), 32)
  assert.equal(parsePositiveInt('1', 16, 'X'), 1)
})

test('parsePositiveInt: 0/负数/NaN/空 → 回退默认', () => {
  for (const raw of ['0', '-3', 'abc', 'NaN', '', '   ', undefined]) {
    assert.equal(parsePositiveInt(raw, 16, 'X'), 16, `raw=${String(raw)}`)
  }
})
