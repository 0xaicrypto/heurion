/**
 * Execution-plane job envelope — the wire contract between server-ts
 * (control plane, producer) and worker (execution plane, consumer).
 *
 * Single source of truth (#678): server-ts client and worker server both
 * import these; no local copies. Field names are snake_case and mirror the
 * wire format exactly.
 */
import { z } from 'zod';
/** Job lifecycle states — the full set both sides may observe. */
export declare const jobStatusSchema: z.ZodEnum<["pending", "running", "completed", "failed"]>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export declare const jobTenantSchema: z.ZodObject<{
    userId: z.ZodOptional<z.ZodString>;
    workspaceId: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    userId?: string | undefined;
    workspaceId?: string | undefined;
}, {
    userId?: string | undefined;
    workspaceId?: string | undefined;
}>;
/** POST /api/v1/jobs request body (worker consumes, server-ts produces). */
export declare const enqueueJobRequestSchema: z.ZodObject<{
    type: z.ZodString;
    payload: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    tenant: z.ZodOptional<z.ZodObject<{
        userId: z.ZodOptional<z.ZodString>;
        workspaceId: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        userId?: string | undefined;
        workspaceId?: string | undefined;
    }, {
        userId?: string | undefined;
        workspaceId?: string | undefined;
    }>>;
    callback_url: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: string;
    payload?: Record<string, unknown> | undefined;
    tenant?: {
        userId?: string | undefined;
        workspaceId?: string | undefined;
    } | undefined;
    callback_url?: string | undefined;
}, {
    type: string;
    payload?: Record<string, unknown> | undefined;
    tenant?: {
        userId?: string | undefined;
        workspaceId?: string | undefined;
    } | undefined;
    callback_url?: string | undefined;
}>;
export type EnqueueJobRequest = z.infer<typeof enqueueJobRequestSchema>;
/** GET /api/v1/jobs/:id response body. */
export declare const jobStatusResponseSchema: z.ZodObject<{
    job_id: z.ZodString;
    status: z.ZodEnum<["pending", "running", "completed", "failed"]>;
    created_at: z.ZodNumber;
    completed_at: z.ZodOptional<z.ZodNumber>;
    result: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    error: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status: "pending" | "running" | "completed" | "failed";
    job_id: string;
    created_at: number;
    error?: string | undefined;
    completed_at?: number | undefined;
    result?: Record<string, unknown> | undefined;
}, {
    status: "pending" | "running" | "completed" | "failed";
    job_id: string;
    created_at: number;
    error?: string | undefined;
    completed_at?: number | undefined;
    result?: Record<string, unknown> | undefined;
}>;
export type JobStatusResponse = z.infer<typeof jobStatusResponseSchema>;
/** POST /api/v1/jobs response body (enqueue acknowledgment). */
export declare const jobEnqueuedResponseSchema: z.ZodObject<Pick<{
    job_id: z.ZodString;
    status: z.ZodEnum<["pending", "running", "completed", "failed"]>;
    created_at: z.ZodNumber;
    completed_at: z.ZodOptional<z.ZodNumber>;
    result: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    error: z.ZodOptional<z.ZodString>;
}, "status" | "job_id" | "created_at">, "strip", z.ZodTypeAny, {
    status: "pending" | "running" | "completed" | "failed";
    job_id: string;
    created_at: number;
}, {
    status: "pending" | "running" | "completed" | "failed";
    job_id: string;
    created_at: number;
}>;
export type JobEnqueuedResponse = z.infer<typeof jobEnqueuedResponseSchema>;
