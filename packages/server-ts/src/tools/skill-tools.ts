import { BaseTool, ToolResult } from './base-tool.js'
import type { SkillsStore } from '../evolution/stores.js'

/**
 * #106: load_skill — the system prompt only carries a short skill index
 * (name + strategy snippet); the model calls this tool to load the full
 * skill record when one becomes relevant.
 */
export class LoadSkillTool extends BaseTool {
  constructor(private ctx: { skills: SkillsStore }) {
    super()
  }

  get name(): string { return 'load_skill' }

  get description(): string {
    return 'Load the full content of a skill. Use when a skill in the active skills list is relevant to the current task.'
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name from the active skills list.' },
      },
      required: ['name'],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const name = String(args.name || '').trim()
    if (!name) return { success: false, error: 'name required' }

    const skill = this.ctx.skills.all().find((s) => s.name === name)
    if (!skill) {
      return { success: false, error: `Unknown skill: ${name}` }
    }

    return {
      success: true,
      output: JSON.stringify(
        {
          name: skill.name,
          task_kind: skill.taskKind,
          best_strategy: skill.bestStrategy,
          stats: {
            task_count: skill.taskCount,
            success_count: skill.successCount,
            failure_count: skill.failureCount,
            success_rate: skill.taskCount > 0 ? Math.round((skill.successCount / skill.taskCount) * 100) : 0,
          },
          created_at: skill.createdAt,
        },
        null,
        2,
      ),
    }
  }
}
