import { describe, test, expect, afterEach } from 'vitest'
import { renderBioScene, resolveIcon, iconCatalog, detectLayoutProblems } from '../../src/tools/bioscene/bioscene.js'
import { RenderSceneTool } from '../../src/tools/bioscene/render-scene-tool.js'
import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * #408: BioScene — restricted icon catalog is the quality gate; rendering
 * is deterministic; unknown icons are rejected.
 */
describe('BioScene (#408)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bioscene-'))
  afterEach(() => {
    process.env.TWIN_BASE_DIR = tmp
  })

  test('icon catalog resolves by id and alias', () => {
    expect(resolveIcon('membrane')).toBeTruthy()
    expect(resolveIcon('EGFR')).toBeTruthy()
    expect(resolveIcon('激酶')).toBeTruthy()
    expect(resolveIcon('不存在')).toBeNull()
    expect(iconCatalog().length).toBeGreaterThanOrEqual(20)
  })

  test('renders a deterministic EGFR signaling scene with connections', () => {
    const svg1 = renderBioScene({
      canvas: { width: 800, height: 600 },
      objects: [
        { icon: 'membrane', x: 50, y: 40, label: 'Membrane' },
        { icon: 'egfr', x: 30, y: 60 },
        { icon: 'p-kinase', x: 50, y: 80 },
        { icon: 'nucleus', x: 75, y: 70 },
      ],
      connections: [
        { from: 1, to: 2, kind: 'phosphorylation', label: 'P' },
        { from: 2, to: 3, kind: 'arrow' },
      ],
      annotations: [{ type: 'text', x: 50, y: 20, text: 'EGFR signaling' }],
    })
    const svg2 = renderBioScene({
      canvas: { width: 800, height: 600 },
      objects: [
        { icon: 'membrane', x: 50, y: 40, label: 'Membrane' },
        { icon: 'egfr', x: 30, y: 60 },
        { icon: 'p-kinase', x: 50, y: 80 },
        { icon: 'nucleus', x: 75, y: 70 },
      ],
      connections: [
        { from: 1, to: 2, kind: 'phosphorylation', label: 'P' },
        { from: 2, to: 3, kind: 'arrow' },
      ],
      annotations: [{ type: 'text', x: 50, y: 20, text: 'EGFR signaling' }],
    })
    expect(svg1).toBe(svg2) // deterministic
    expect(svg1).toContain('<svg')
    expect(svg1).toContain('EGFR signaling')
  })

  test('render_scene tool rejects unknown icons', async () => {
    process.env.TWIN_BASE_DIR = tmp
    const tool = new RenderSceneTool({ userId: 'u1' })
    const res = await tool.execute({
      objects: [{ icon: 'flying-spaceship', x: 10, y: 10 }],
    })
    expect(res.success).toBe(false)
    expect(res.error).toContain('Unknown icons')
  })

  test('render_scene tool saves the SVG and returns a file', async () => {
    const tool = new RenderSceneTool({ userId: 'u1' })
    const res = await tool.execute({
      title: 'signaling',
      canvas: { width: 600, height: 400 },
      objects: [
        { icon: 't-cell', x: 30, y: 50, label: 'T cell' },
        { icon: 'tumor-cell', x: 70, y: 50, label: 'Tumor' },
        { icon: 'tki', x: 50, y: 80, label: 'TKI' },
      ],
      connections: [{ from: 0, to: 1, kind: 'arrow' }],
    })
    expect(res.success).toBe(true)
    const out = JSON.parse(res.output!)
    expect(out.file_id).toMatch(/^scene_/)
    expect(fs.existsSync(path.join(tmp, 'u1', 'uploads', out.file_id))).toBe(true)
    // #440: <img>-friendly download URL — token-first route + auth query token.
    expect(out.url).toMatch(/^\/api\/v1\/files\/download\/scene_.*\.svg\?token=/)
    expect(out.markdown).toBe(`![signaling](${out.url})`)
  })
})

  test('pixel coordinates (0-1000) are accepted and scaled', () => {
    const svg = renderBioScene({
      canvas: { width: 800, height: 600 },
      objects: [
        { icon: 'cell', x: 200, y: 150 },
        { icon: 'nucleus', x: 600, y: 450 },
      ],
      connections: [{ from: 0, to: 1, kind: 'arrow' }],
    })
    // 200/1000*800 = 160 → 160-24=136; 150/1000*600 = 90 → 90-24=66.
    expect(svg).toContain('translate(136, 66)')
    // 600/1000*800 = 480 → 480-24=456; 450/1000*600 = 270 → 270-24=246.
    expect(svg).toContain('translate(456, 246)')
  })

  test('annotation pixel coordinates render', () => {
    const svg = renderBioScene({
      canvas: { width: 800, height: 600 },
      objects: [{ icon: 'cell', x: 50, y: 50 }],
      annotations: [{ type: 'text', x: 400, y: 100, text: 'Pixel label' }],
    })
    expect(svg).toContain('Pixel label')
  })

  test('#467 external NIH BioArt icons resolve and embed (svgFile)', () => {    expect(resolveIcon('t-cell')).toBeTruthy()
    expect(resolveIcon('巨噬细胞')?.id).toBe('macrophage')
    expect(resolveIcon('NK细胞')?.id).toBe('nk-cell')
    expect(resolveIcon('antibody')?.id).toBe('antibody')
    expect(resolveIcon('HIV')?.id).toBe('hiv')
    // Catalog includes the external set.
    const catalog = iconCatalog()
    expect(catalog.some((i) => i.id === 'macrophage')).toBe(true)
    expect(catalog.length).toBeGreaterThanOrEqual(21 + 15)

    const svg = renderBioScene({
      canvas: { width: 800, height: 600 },
      objects: [
        { icon: 'macrophage', x: 30, y: 50, label: 'Mφ' },
        { icon: 'tumor-cell', x: 70, y: 50 },
      ],
      connections: [{ from: 0, to: 1, kind: 'arrow' }],
    })
    // External SVG content is embedded (metadata + namespaced defs from
    // NIH BioArt).
    expect(svg).toContain('metadata')
    expect(svg).toContain('Macrophage')
    expect(svg).toContain('Mφ')
    expect(svg).toContain('translate(216, 276)') // 30% of 800 = 240 - 24
  })

  test('#468 palette: default keeps legacy gray, clinical colors by category', () => {
    const scene = {
      canvas: { width: 800, height: 600 },
      objects: [
        { icon: 'egfr', x: 30, y: 50, label: 'EGFR' },
        { icon: 'kinase', x: 50, y: 50 },
      ],
    }
    const legacy = renderBioScene(scene as any) // no palette arg
    expect(legacy).toContain('stroke="#334155"')

    const clinical = renderBioScene(scene as any, 'clinical')
    // receptor category → blue; enzyme → green
    expect(clinical).toContain('stroke="#2563eb"')
    expect(clinical).toContain('stroke="#16a34a"')
    // Explicit colorize always wins.
    const explicit = renderBioScene({ ...scene, objects: [{ icon: 'egfr', x: 30, y: 50, colorize: '#f00' }] } as any, 'clinical')
    expect(explicit).toContain('stroke="#f00"')

    // Deterministic: same input + palette → identical output.
    expect(renderBioScene(scene as any, 'clinical')).toBe(clinical)
  })

  test('#468 journal palette renders distinct low-saturation colors', () => {
    const scene = { canvas: { width: 800, height: 600 }, objects: [{ icon: 'pd-l1', x: 50, y: 50 }] }
    const journal = renderBioScene(scene as any, 'journal')
    expect(journal).toContain('stroke="#60a5fa"') // receptor → soft blue
    expect(journal).not.toContain('stroke="#2563eb"')
  })

  test('#layout-guard: overlapping icons are detected and warned', () => {
    const bad = detectLayoutProblems({
      canvas: { width: 800, height: 600 },
      objects: [
        { icon: 'egfr', x: 50, y: 50 },
        { icon: 'kinase', x: 52, y: 52 }, // stacked on EGFR
        { icon: 'nucleus', x: 80, y: 80 },
      ],
    })
    expect(bad).toContain('overlapping')
    expect(bad).toContain('egfr+kinase')

    const good = detectLayoutProblems({
      canvas: { width: 800, height: 600 },
      objects: [
        { icon: 'egfr', x: 20, y: 50 },
        { icon: 'kinase', x: 50, y: 50 },
        { icon: 'nucleus', x: 80, y: 50 },
      ],
    })
    expect(good).toBeNull()

    // Scale is clamped for the overlap check (4x icon still counts as 3x).
    const huge = detectLayoutProblems({
      canvas: { width: 800, height: 600 },
      objects: [
        { icon: 'cell', x: 50, y: 50, scale: 4 },
        { icon: 'egfr', x: 56, y: 50 },
      ],
    })
    expect(huge).toContain('overlapping')
  })
