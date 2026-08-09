import { describe, test, expect } from 'vitest'
import { parseCsv, analyzeCsvText } from '../../src/lib/data-table.js'
import { LoadDataTableTool } from '../../src/tools/data-table-tool.js'

/**
 * #406: data input pipeline — CSV parsing, shape inference, preview.
 */
describe('data input pipeline (#406)', () => {
  test('parses quoted CSV with commas and newlines', () => {
    const rows = parseCsv('a,b,c\n"x,1",y,"multi\nline"\n1,2,3')
    expect(rows[0]).toEqual(['a', 'b', 'c'])
    expect(rows[1][0]).toBe('x,1')
    expect(rows[1][2]).toBe('multi\nline')
    expect(rows[2]).toEqual(['1', '2', '3'])
  })

  test('survival CSV → survival_table', () => {
    const info = analyzeCsvText('time,event,group\n5,1,A\n6,0,A\n8,1,B')
    expect(info.shape).toBe('survival_table')
    expect(info.totalRows).toBe(3)
    expect(info.preview.length).toBe(3)
  })

  test('two numeric columns → values_paired', () => {
    const info = analyzeCsvText('baseline,post\n10,12\n11,13\n9,14')
    expect(info.shape).toBe('values_paired')
    expect(info.columns.every((c) => c.kind === 'number')).toBe(true)
  })

  test('group + value → grouped_table; label + counts → contingency_table', () => {
    const g = analyzeCsvText('group,value\nA,3.1\nB,4.2\nA,3.8')
    expect(g.shape).toBe('grouped_table')
    const c = analyzeCsvText('stage,responder,nonresponder\nI,30,10\nII,20,20')
    expect(c.shape).toBe('contingency_table')
  })

  test('continuous x/y → continuous_x_y; summary mentions shape', () => {
    const info = analyzeCsvText('dose,response\n0,10\n1,15\n5,30')
    expect(info.shape).toBe('continuous_x_y')
    expect(info.summary).toContain('continuous_x_y')
    expect(info.summary).toContain('均值')
  })

  test('load_data_table tool reads raw CSV and file', async () => {
    const tool = new LoadDataTableTool({ userId: 'u1' })
    const res = await tool.execute({ csv_text: 'time,event\n5,1\n6,0\n8,1' })
    expect(res.success).toBe(true)
    const out = JSON.parse(res.output!)
    expect(out.shape).toBe('survival_table')
    expect(out.preview.length).toBe(3)

    const bad = await tool.execute({})
    expect(bad.success).toBe(false)
  })
})
