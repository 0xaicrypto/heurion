import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'

export interface WorkflowStep {
  name: string
  skill?: string
  prompt?: string
  tool?: string
  input_map?: Record<string, string>
}

export interface WorkflowDefinition {
  id: string
  userId: string
  name: string
  description: string
  category: string
  steps: WorkflowStep[]
  inputs: Record<string, { type: string; description: string; required?: boolean }>
  createdAt: string
  updatedAt: string
}

export interface WorkflowRun {
  id: string
  workflowId: string
  userId: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  input: Record<string, unknown>
  steps: Array<WorkflowStep & { status: string; output?: string; error?: string }>
  result: string
  error: string
  createdAt: string
  completedAt: string | null
}

export interface StarterPack {
  id: string
  name: string
  description: string
  category: string
  workflows: Array<{ name: string; description: string; steps: WorkflowStep[] }>
}

const DEFAULT_PACKS: StarterPack[] = [
  {
    id: 'pack_clinical_review',
    name: 'Clinical Review',
    description: 'Review patient findings and generate a summary',
    category: 'clinical',
    workflows: [
      { name: 'Review & Summarize', description: 'Review patient data and create a summary', steps: [] },
    ],
  },
  {
    id: 'pack_research_protocol',
    name: 'Research Protocol',
    description: 'Analyze study protocols and screen patients',
    category: 'research',
    workflows: [
      { name: 'Protocol Import', description: 'Import and extract protocol rules', steps: [] },
    ],
  },
]

export class WorkflowService {
  private dbDir: string
  private workflows: WorkflowDefinition[] = []
  private runs: WorkflowRun[] = []

  constructor(baseDir: string) {
    this.dbDir = path.join(baseDir, 'workflows')
    fs.mkdirSync(this.dbDir, { recursive: true })
    this.load()
  }

  private load(): void {
    const wfPath = path.join(this.dbDir, 'workflows.json')
    const runsPath = path.join(this.dbDir, 'runs.json')
    try {
      if (fs.existsSync(wfPath)) this.workflows = JSON.parse(fs.readFileSync(wfPath, 'utf-8'))
      if (fs.existsSync(runsPath)) this.runs = JSON.parse(fs.readFileSync(runsPath, 'utf-8'))
    } catch { /* ignore corrupt data */ }
  }

  private save(): void {
    fs.writeFileSync(path.join(this.dbDir, 'workflows.json'), JSON.stringify(this.workflows, null, 2))
    fs.writeFileSync(path.join(this.dbDir, 'runs.json'), JSON.stringify(this.runs, null, 2))
  }

  list(userId: string): WorkflowDefinition[] {
    return this.workflows.filter(w => w.userId === userId)
  }

  get(id: string): WorkflowDefinition | undefined {
    return this.workflows.find(w => w.id === id)
  }

  create(input: { name: string; description?: string; category?: string; steps?: WorkflowStep[]; inputs?: Record<string, any> }, userId: string): WorkflowDefinition {
    const now = new Date().toISOString()
    const wf: WorkflowDefinition = {
      id: `wf_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      userId,
      name: input.name,
      description: input.description || '',
      category: input.category || 'general',
      steps: input.steps || [],
      inputs: input.inputs || {},
      createdAt: now,
      updatedAt: now,
    }
    this.workflows.push(wf)
    this.save()
    return wf
  }

  update(id: string, patch: Partial<Pick<WorkflowDefinition, 'name' | 'description' | 'category' | 'steps' | 'inputs'>>): WorkflowDefinition | null {
    const idx = this.workflows.findIndex(w => w.id === id)
    if (idx === -1) return null
    this.workflows[idx] = { ...this.workflows[idx], ...patch, updatedAt: new Date().toISOString() }
    this.save()
    return this.workflows[idx]
  }

  delete(id: string): boolean {
    const before = this.workflows.length
    this.workflows = this.workflows.filter(w => w.id !== id)
    if (this.workflows.length < before) { this.save(); return true }
    return false
  }

  listRuns(userId: string, workflowId?: string): WorkflowRun[] {
    let results = this.runs.filter(r => r.userId === userId)
    if (workflowId) results = results.filter(r => r.workflowId === workflowId)
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  getRun(id: string): WorkflowRun | undefined {
    return this.runs.find(r => r.id === id)
  }

  createRun(workflowId: string, userId: string, input: Record<string, unknown> = {}): WorkflowRun {
    const wf = this.get(workflowId)
    const now = new Date().toISOString()
    const run: WorkflowRun = {
      id: `run_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      workflowId,
      userId,
      status: 'pending',
      input,
      steps: (wf?.steps || []).map(s => ({ ...s, status: 'pending' })),
      result: '',
      error: '',
      createdAt: now,
      completedAt: null,
    }
    this.runs.unshift(run)
    this.save()
    return run
  }

  listPacks(): StarterPack[] {
    return DEFAULT_PACKS
  }

  installPack(packId: string, userId: string): WorkflowDefinition[] {
    const pack = DEFAULT_PACKS.find(p => p.id === packId)
    if (!pack) return []
    return pack.workflows.map(w => this.create({
      name: w.name,
      description: w.description,
      category: pack.category,
      steps: w.steps,
    }, userId))
  }
}
