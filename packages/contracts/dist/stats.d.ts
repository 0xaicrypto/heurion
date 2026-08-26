/**
 * Statistics worker contract (#689) — the request/response shapes shared
 * between server-ts (producer) and python-stats-worker (scipy consumer).
 *
 * Field names are snake_case on the wire. python-stats-worker/main.py
 * mirrors this schema with an isomorphic pydantic model — keep both in sync.
 */
import { z } from 'zod';
export declare const statsRequestSchema: z.ZodObject<{
    test: z.ZodString;
    group_a: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
    group_b: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
    table: z.ZodOptional<z.ZodArray<z.ZodArray<z.ZodNumber, "many">, "many">>;
    values: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
    survival_a: z.ZodOptional<z.ZodArray<z.ZodObject<{
        time: z.ZodNumber;
        event: z.ZodBoolean;
    }, "strip", z.ZodTypeAny, {
        time: number;
        event: boolean;
    }, {
        time: number;
        event: boolean;
    }>, "many">>;
    survival_b: z.ZodOptional<z.ZodArray<z.ZodObject<{
        time: z.ZodNumber;
        event: z.ZodBoolean;
    }, "strip", z.ZodTypeAny, {
        time: number;
        event: boolean;
    }, {
        time: number;
        event: boolean;
    }>, "many">>;
    group: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    factor_a: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    test: string;
    group_a?: number[] | undefined;
    group_b?: number[] | undefined;
    table?: number[][] | undefined;
    values?: number[] | undefined;
    survival_a?: {
        time: number;
        event: boolean;
    }[] | undefined;
    survival_b?: {
        time: number;
        event: boolean;
    }[] | undefined;
    group?: string[] | undefined;
    factor_a?: string[] | undefined;
}, {
    test: string;
    group_a?: number[] | undefined;
    group_b?: number[] | undefined;
    table?: number[][] | undefined;
    values?: number[] | undefined;
    survival_a?: {
        time: number;
        event: boolean;
    }[] | undefined;
    survival_b?: {
        time: number;
        event: boolean;
    }[] | undefined;
    group?: string[] | undefined;
    factor_a?: string[] | undefined;
}>;
export type StatsRequest = z.infer<typeof statsRequestSchema>;
/** Loose report shape — each test returns a different report object. */
export declare const statsReportSchema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
export type StatsReport = z.infer<typeof statsReportSchema>;
export declare const statsResponseSchema: z.ZodObject<{
    report: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, "strip", z.ZodTypeAny, {
    report: Record<string, unknown>;
}, {
    report: Record<string, unknown>;
}>;
export type StatsResponse = z.infer<typeof statsResponseSchema>;
