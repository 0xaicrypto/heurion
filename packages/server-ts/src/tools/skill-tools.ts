import { BaseTool, ToolResult } from './base-tool.js'
import type { SkillsStore } from '../evolution/stores.js'
import type { MemoryService } from '../memory/memory.service.js'

/**
 * #106: load_skill — the system prompt only carries a short skill index
 * (剧本卡摘要);the model calls this tool to load the FULL skill when relevant.
 *
 * #841 环④/#842: 双源 — graph SkillNode v2(单一事实源,返回完整剧本:
 * steps + promptTemplate)优先,legacy SkillsStore 回落。suspended/deprecated
 * 的 graph skill 不再可加载(降级不删除但停止激活)。
 */
export class LoadSkillTool extends BaseTool {
  constructor(private ctx: { skills: SkillsStore; memory?: MemoryService }) {
    super()
  }

  get name(): string { return 'load_skill' }

  get description(): string {
    return 'Load the full content of a skill (steps + reusable prompt template). Use when a skill in the active skills list is relevant to the current task.'
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

    // graph SkillNode v2(单一事实源)
    const node = (this.ctx.memory?.graph?.getCurrentNodesByType('skill') ?? []) as any[]
    const graphSkill = node.find((s: any) => s.name === name)
    if (graphSkill) {
      if (graphSkill.lifecycle && graphSkill.lifecycle !== 'active') {
        return { success: false, error: `Skill "${name}" 已${graphSkill.lifecycle === 'suspended' ? '暂停' : '退役'}(降级不删除,重审后可恢复)` }
      }
      return {
        success: true,
        output: JSON.stringify(
          {
            name: graphSkill.name,
            description: graphSkill.description || '',
            steps: graphSkill.steps ?? [],
            prompt_template: graphSkill.promptTemplate || '',
            task_kind: graphSkill.taskKind,
            scope: graphSkill.scope,
            source: graphSkill.source,
            stats: {
              task_count: graphSkill.taskCount ?? 0,
              success_count: graphSkill.successCount ?? 0,
              failure_count: graphSkill.failureCount ?? 0,
              follow_rate: graphSkill.followRate ?? 0,
            },
            stable_id: graphSkill.stableId,
          },
          null,
          2,
        ),
      }
    }

    // legacy SkillsStore 回落(旧数据/测试)
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
