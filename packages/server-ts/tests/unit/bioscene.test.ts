import { describe, test, expect, afterEach } from 'vitest'
import { renderBioScene, resolveIcon, iconCatalog } from '../../src/tools/bioscene/bioscene.js'
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
  })
})
