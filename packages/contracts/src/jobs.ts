/**
 * Execution-plane job envelope — the wire contract between server-ts
 * (control plane, producer) and worker (execution plane, consumer).
 *
 * Single source of truth (#678): server-ts client and worker server both
 * import these; no local copies. Field names are snake_case and mirror the
 * wire format exactly.
 */
import { z } from 'zod'

/** Job lifecycle states — the full set both sides may observe. */
export const jobStatusSchema = z.enum(['pending', 'running', 'completed', 'failed'])
export type JobStatus = z.infer<typeof jobStatusSchema>

export const jobTenantSchema = z.object({
  userId: z.string().optional(),
  workspaceId: z.string().optional(),
})

/** POST /api/v1/jobs request body (worker consumes, server-ts produces). */
export const enqueueJobRequestSchema = z.object({
  type: z.string().min(1, 'type is required'),
  payload: z.record(z.string(), z.unknown()).optional(),
  tenant: jobTenantSchema.optional(),
  callback_url: z.string().optional(),
})
export type EnqueueJobRequest = z.infer<typeof enqueueJobRequestSchema>

/** GET /api/v1/jobs/:id response body. */
export const jobStatusResponseSchema = z.object({
  job_id: z.string(),
  status: jobStatusSchema,
  created_at: z.number(),
  completed_at: z.number().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
})
export type JobStatusResponse = z.infer<typeof jobStatusResponseSchema>

/** POST /api/v1/jobs response body (enqueue acknowledgment). */
export const jobEnqueuedResponseSchema = jobStatusResponseSchema.pick({
  job_id: true,
  status: true,
  created_at: true,
})
export type JobEnqueuedResponse = z.infer<typeof jobEnqueuedResponseSchema>
