import { describe, test, expect, vi, afterEach } from 'vitest'
import { RenderSceneTool } from '../../src/tools/bioscene/render-scene-tool.js'
import { resolvePathway, searchPathways, fetchPathwayDiagram } from '../../src/tools/bioscene/reactome-service.js'
import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * #466: Reactome pathway diagram mode — catalog resolution (中英文),
 * candidate lists, local cache + dynamic load from object storage.
 */
describe('Reactome pathway mode (#466)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reactome-'))
  const tool = new RenderSceneTool({ userId: 'u1' })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    process.env.TWIN_BASE_DIR = tmp
    fs.rmSync(path.join(tmp, 'reactome-diagrams'), { recursive: true, force: true })
  })

  test('catalog resolves by English name, Chinese alias and ID', () => {
    expect(resolvePathway('EGFR signaling')?.id).toBe('R-HSA-177929')
    expect(resolvePathway('EGFR 信号')?.id).toBe('R-HSA-177929')
    expect(resolvePathway('表皮生长因子受体信号')?.id).toBe('R-HSA-177929')
    expect(resolvePathway('R-HSA-389948')?.name).toBe('Co-inhibition by PD-1')
    expect(resolvePathway('PD-1 共抑制')?.id).toBe('R-HSA-389948')
  })

  test('fuzzy resolution and candidates', () => {
    expect(resolvePathway('EGFR')?.id).toBe('R-HSA-177929')
    const hits = searchPathways('apoptosis')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((h) => h.name.includes('Apoptosis'))).toBe(true)
    expect(resolvePathway('不存在通路xyz')).toBeNull()
  })

  test('unknown pathway returns candidates to the LLM', async () => {
    process.env.TWIN_BASE_DIR = tmp
    const res = await tool.execute({ template_source: 'reactome', pathway: '不存在通路xyz' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('Unknown Reactome pathway')
    expect(res.error).toContain('try')
  })

  test('fetchPathwayDiagram: local cache hit without network', async () => {
    const stId = 'R-HSA-177929'
    const cacheDir = path.join(tmp, 'reactome-diagrams')
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(path.join(cacheDir, `${stId}.svg`), '<svg>cached</svg>', 'utf-8')

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    process.env.TWIN_BASE_DIR = tmp

    const svg = await fetchPathwayDiagram(stId)
    expect(svg).toContain('cached')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('fetchPathwayDiagram: downloads from object storage and caches', async () => {
    process.env.TWIN_BASE_DIR = tmp
    process.env.REACTOME_DIAGRAMS_BASE_URL = 'https://cdn.example.com/reactome-diagrams'
    vi.stubGlobal('fetch', vi.fn(async (url: any) => {
      expect(String(url)).toBe('https://cdn.example.com/reactome-diagrams/R-HSA-389948.svg')
      return { ok: true, text: async () => '<svg>from-storage</svg>' } as any
    }))

    const svg = await fetchPathwayDiagram('R-HSA-389948')
    expect(svg).toContain('from-storage')
    // Second call is a cache hit (no network).
    expect(await fetchPathwayDiagram('R-HSA-389948')).toContain('from-storage')
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })

  test('fetchPathwayDiagram: null when storage is not configured', async () => {
    process.env.TWIN_BASE_DIR = tmp
    delete process.env.REACTOME_DIAGRAMS_BASE_URL
    expect(await fetchPathwayDiagram('R-HSA-999999')).toBeNull()
  })

  test('render_scene reactome mode: full flow with storage configured', async () => {
    process.env.TWIN_BASE_DIR = tmp
    process.env.REACTOME_DIAGRAMS_BASE_URL = 'https://cdn.example.com/reactome-diagrams'
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '<svg viewBox="0 0 100 100"><path d="M1 1"/></svg>' } as any)))

    const res = await tool.execute({ template_source: 'reactome', pathway: 'EGFR 信号', title: 'EGFR 信号' })
    expect(res.success).toBe(true)
    const out = JSON.parse(res.output!)
    expect(out.pathway_id).toBe('R-HSA-177929')
    expect(out.url).toMatch(/^\/api\/v1\/files\/download\/scene_.*\.svg\?token=/)
    expect(out.markdown).toContain('![EGFR 信号]')
    expect(out.markdown).toContain('CC BY 4.0')
    expect(fs.existsSync(path.join(tmp, 'u1', 'uploads', out.file_id))).toBe(true)
  })
})
