/**
 * #349: request validation for core write routes — zod schemas in the
 * auth.dto.ts style. Invalid bodies fail at the entry with a 400 + clear
 * message instead of crashing mid-request.
 */
import { z } from 'zod'

export const chatSendSchema = z.object({
  text: z.string().min(1).max(32000),
  session_id: z.string().min(1).max(128).optional(),
  patient_hash: z.string().min(1).max(128).nullable().optional(),
  /** #510: entry scene — overrides server-side inference (patient_hash / doc- session). */
  scene: z.enum(['general', 'patient', 'document', 'chart']).optional(),
  /** #620/#628: 知识库选择器选定的文章/文件 stableId — zod 默认剥离未知字段,
   *  不加 schema 会在入口被静默丢弃(前端发了但后端永远收不到)。 */
  picked_kb_ids: z.array(z.string().min(1).max(512)).max(3).optional(),
  /** #693: 用户在写作编辑器选中的文本(选中即引用) — 注入对话上下文,
   *  模型 old_text 从此处逐字复制,同源保证锚点必然命中。 */
  selection: z.string().min(1).max(20000).optional(),
  attachments: z
    .array(
      z.union([
        z.string().min(1).max(512),
        z.object({
          file_id: z.string().max(512).optional(),
          fileId: z.string().max(512).optional(),
          name: z.string().max(256).optional(),
        }),
      ]),
    )
    .max(20)
    .optional(),
})

export type ChatSendInput = z.infer<typeof chatSendSchema>

export const memoryImportSchema = z
  .object({
    facts: z
      .array(
        z.object({
          content: z.string().min(1).max(4000),
          category: z.enum(['allergy', 'constraint', 'context', 'diagnosis', 'exam', 'fact', 'goal', 'medication', 'plan', 'preference', 'symptom']).optional(),
          importance: z.number().min(1).max(5).optional(),
          sourceType: z.enum(['doctor', 'document', 'general', 'patient', 'research', 'sidecar']).optional(),
          patientHash: z.string().max(128).optional(),
          studyId: z.string().max(128).optional(),
        }),
      )
      .max(200)
      .optional(),
    episodes: z
      .array(
        z.object({
          sessionId: z.string().max(128).optional(),
          summary: z.string().max(4000).optional(),
          turnCount: z.number().int().min(0).optional(),
        }),
      )
      .max(200)
      .optional(),
  })

export type MemoryImportInput = z.infer<typeof memoryImportSchema>

export const manualMemorySchema = z.object({
  content: z.string().min(1).max(4000),
  category: z.string().max(64).optional(),
  importance: z.number().int().min(1).max(5).optional(),
  patient_hash: z.string().max(128).nullable().optional(),
})

export type ManualMemoryInput = z.infer<typeof manualMemorySchema>

export const registerPatientSchema = z.object({
  initials: z.string().min(1).max(16),
  age: z.number().int().min(0).max(130).optional(),
  sex: z.enum(['M', 'F', 'O']).optional(),
  chief_complaint: z.string().max(2000).optional(),
})

export type RegisterPatientInput = z.infer<typeof registerPatientSchema>
