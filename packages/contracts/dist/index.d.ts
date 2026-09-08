/**
 * Render-content contracts — the single source of truth between the AI side
 * (server-ts: LLM → validated JSON) and the render side (worker: JSON →
 * .pptx/.docx/plot/table).
 *
 * Design (review 2026-08-09):
 * - AI produces content & structure ONLY (sections, titles, paragraphs,
 *   tables, image refs, styles) — never file formats.
 * - The generator is a pure executor: same input → same file.
 * - Input is a versioned, validate-able JSON content model:
 *   { schemaVersion: 1, ... }
 * - Binary (images/logos) travels as refs: { type: "image", ref: "asset://logo.png" }
 *   or inline base64 — the generator resolves and embeds.
 */
import { z } from 'zod';
export * from './chat.js';
export * from './jobs.js';
export * from './stats.js';
export * from './knowledge.js';
export declare const SCHEMA_VERSION = 1;
export declare const imageBlockSchema: z.ZodObject<{
    type: z.ZodLiteral<"image">;
    /** "asset://name" (resolved from a configured asset dir) or an inline data/base64 string. */
    ref: z.ZodEffects<z.ZodString, string, string>;
    caption: z.ZodOptional<z.ZodString>;
    /** Inline base64 data (alternative to ref). */
    data: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "image";
    ref: string;
    caption?: string | undefined;
    data?: string | undefined;
}, {
    type: "image";
    ref: string;
    caption?: string | undefined;
    data?: string | undefined;
}>;
export type ImageBlock = z.infer<typeof imageBlockSchema>;
export declare const paragraphBlockSchema: z.ZodObject<{
    type: z.ZodLiteral<"paragraph">;
    text: z.ZodString;
    style: z.ZodOptional<z.ZodEnum<["normal", "bullet", "heading"]>>;
}, "strip", z.ZodTypeAny, {
    type: "paragraph";
    text: string;
    style?: "bullet" | "heading" | "normal" | undefined;
}, {
    type: "paragraph";
    text: string;
    style?: "bullet" | "heading" | "normal" | undefined;
}>;
export type ParagraphBlock = z.infer<typeof paragraphBlockSchema>;
export declare const contentBlockSchema: z.ZodUnion<[z.ZodObject<{
    type: z.ZodLiteral<"paragraph">;
    text: z.ZodString;
    style: z.ZodOptional<z.ZodEnum<["normal", "bullet", "heading"]>>;
}, "strip", z.ZodTypeAny, {
    type: "paragraph";
    text: string;
    style?: "bullet" | "heading" | "normal" | undefined;
}, {
    type: "paragraph";
    text: string;
    style?: "bullet" | "heading" | "normal" | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"image">;
    /** "asset://name" (resolved from a configured asset dir) or an inline data/base64 string. */
    ref: z.ZodEffects<z.ZodString, string, string>;
    caption: z.ZodOptional<z.ZodString>;
    /** Inline base64 data (alternative to ref). */
    data: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "image";
    ref: string;
    caption?: string | undefined;
    data?: string | undefined;
}, {
    type: "image";
    ref: string;
    caption?: string | undefined;
    data?: string | undefined;
}>]>;
export type ContentBlock = z.infer<typeof contentBlockSchema>;
export declare const presentationSlideSchema: z.ZodObject<{
    title: z.ZodString;
    content: z.ZodArray<z.ZodUnion<[z.ZodObject<{
        type: z.ZodLiteral<"paragraph">;
        text: z.ZodString;
        style: z.ZodOptional<z.ZodEnum<["normal", "bullet", "heading"]>>;
    }, "strip", z.ZodTypeAny, {
        type: "paragraph";
        text: string;
        style?: "bullet" | "heading" | "normal" | undefined;
    }, {
        type: "paragraph";
        text: string;
        style?: "bullet" | "heading" | "normal" | undefined;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        /** "asset://name" (resolved from a configured asset dir) or an inline data/base64 string. */
        ref: z.ZodEffects<z.ZodString, string, string>;
        caption: z.ZodOptional<z.ZodString>;
        /** Inline base64 data (alternative to ref). */
        data: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "image";
        ref: string;
        caption?: string | undefined;
        data?: string | undefined;
    }, {
        type: "image";
        ref: string;
        caption?: string | undefined;
        data?: string | undefined;
    }>]>, "many">;
}, "strip", z.ZodTypeAny, {
    title: string;
    content: ({
        type: "image";
        ref: string;
        caption?: string | undefined;
        data?: string | undefined;
    } | {
        type: "paragraph";
        text: string;
        style?: "bullet" | "heading" | "normal" | undefined;
    })[];
}, {
    title: string;
    content: ({
        type: "image";
        ref: string;
        caption?: string | undefined;
        data?: string | undefined;
    } | {
        type: "paragraph";
        text: string;
        style?: "bullet" | "heading" | "normal" | undefined;
    })[];
}>;
export type PresentationSlide = z.infer<typeof presentationSlideSchema>;
export declare const presentationContentSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    title: z.ZodString;
    subtitle: z.ZodOptional<z.ZodString>;
    presenter: z.ZodOptional<z.ZodString>;
    date: z.ZodOptional<z.ZodString>;
    slides: z.ZodArray<z.ZodObject<{
        title: z.ZodString;
        content: z.ZodArray<z.ZodUnion<[z.ZodObject<{
            type: z.ZodLiteral<"paragraph">;
            text: z.ZodString;
            style: z.ZodOptional<z.ZodEnum<["normal", "bullet", "heading"]>>;
        }, "strip", z.ZodTypeAny, {
            type: "paragraph";
            text: string;
            style?: "bullet" | "heading" | "normal" | undefined;
        }, {
            type: "paragraph";
            text: string;
            style?: "bullet" | "heading" | "normal" | undefined;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"image">;
            /** "asset://name" (resolved from a configured asset dir) or an inline data/base64 string. */
            ref: z.ZodEffects<z.ZodString, string, string>;
            caption: z.ZodOptional<z.ZodString>;
            /** Inline base64 data (alternative to ref). */
            data: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "image";
            ref: string;
            caption?: string | undefined;
            data?: string | undefined;
        }, {
            type: "image";
            ref: string;
            caption?: string | undefined;
            data?: string | undefined;
        }>]>, "many">;
    }, "strip", z.ZodTypeAny, {
        title: string;
        content: ({
            type: "image";
            ref: string;
            caption?: string | undefined;
            data?: string | undefined;
        } | {
            type: "paragraph";
            text: string;
            style?: "bullet" | "heading" | "normal" | undefined;
        })[];
    }, {
        title: string;
        content: ({
            type: "image";
            ref: string;
            caption?: string | undefined;
            data?: string | undefined;
        } | {
            type: "paragraph";
            text: string;
            style?: "bullet" | "heading" | "normal" | undefined;
        })[];
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    schemaVersion: 1;
    title: string;
    subtitle?: string | undefined;
    presenter?: string | undefined;
    date?: string | undefined;
    slides: {
        title: string;
        content: ({
            type: "image";
            ref: string;
            caption?: string | undefined;
            data?: string | undefined;
        } | {
            type: "paragraph";
            text: string;
            style?: "bullet" | "heading" | "normal" | undefined;
        })[];
    }[];
}, {
    schemaVersion: 1;
    title: string;
    subtitle?: string | undefined;
    presenter?: string | undefined;
    date?: string | undefined;
    slides: {
        title: string;
        content: ({
            type: "image";
            ref: string;
            caption?: string | undefined;
            data?: string | undefined;
        } | {
            type: "paragraph";
            text: string;
            style?: "bullet" | "heading" | "normal" | undefined;
        })[];
    }[];
}>;
export type PresentationContent = z.infer<typeof presentationContentSchema>;
export declare const documentSectionSchema: z.ZodObject<{
    heading: z.ZodString;
    paragraphs: z.ZodArray<z.ZodUnion<[z.ZodObject<{
        type: z.ZodLiteral<"paragraph">;
        text: z.ZodString;
        style: z.ZodOptional<z.ZodEnum<["normal", "bullet", "heading"]>>;
    }, "strip", z.ZodTypeAny, {
        type: "paragraph";
        text: string;
        style?: "bullet" | "heading" | "normal" | undefined;
    }, {
        type: "paragraph";
        text: string;
        style?: "bullet" | "heading" | "normal" | undefined;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        /** "asset://name" (resolved from a configured asset dir) or an inline data/base64 string. */
        ref: z.ZodEffects<z.ZodString, string, string>;
        caption: z.ZodOptional<z.ZodString>;
        /** Inline base64 data (alternative to ref). */
        data: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "image";
        ref: string;
        caption?: string | undefined;
        data?: string | undefined;
    }, {
        type: "image";
        ref: string;
        caption?: string | undefined;
        data?: string | undefined;
    }>]>, "many">;
}, "strip", z.ZodTypeAny, {
    heading: string;
    paragraphs: ({
        type: "image";
        ref: string;
        caption?: string | undefined;
        data?: string | undefined;
    } | {
        type: "paragraph";
        text: string;
        style?: "bullet" | "heading" | "normal" | undefined;
    })[];
}, {
    heading: string;
    paragraphs: ({
        type: "image";
        ref: string;
        caption?: string | undefined;
        data?: string | undefined;
    } | {
        type: "paragraph";
        text: string;
        style?: "bullet" | "heading" | "normal" | undefined;
    })[];
}>;
export type DocumentSection = z.infer<typeof documentSectionSchema>;
export declare const documentContentSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    title: z.ZodString;
    sections: z.ZodArray<z.ZodObject<{
        heading: z.ZodString;
        paragraphs: z.ZodArray<z.ZodUnion<[z.ZodObject<{
            type: z.ZodLiteral<"paragraph">;
            text: z.ZodString;
            style: z.ZodOptional<z.ZodEnum<["normal", "bullet", "heading"]>>;
        }, "strip", z.ZodTypeAny, {
            type: "paragraph";
            text: string;
            style?: "bullet" | "heading" | "normal" | undefined;
        }, {
            type: "paragraph";
            text: string;
            style?: "bullet" | "heading" | "normal" | undefined;
        }>, z.ZodObject<{
            type: z.ZodLiteral<"image">;
            /** "asset://name" (resolved from a configured asset dir) or an inline data/base64 string. */
            ref: z.ZodEffects<z.ZodString, string, string>;
            caption: z.ZodOptional<z.ZodString>;
            /** Inline base64 data (alternative to ref). */
            data: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            type: "image";
            ref: string;
            caption?: string | undefined;
            data?: string | undefined;
        }, {
            type: "image";
            ref: string;
            caption?: string | undefined;
            data?: string | undefined;
        }>]>, "many">;
    }, "strip", z.ZodTypeAny, {
        heading: string;
        paragraphs: ({
            type: "image";
            ref: string;
            caption?: string | undefined;
            data?: string | undefined;
        } | {
            type: "paragraph";
            text: string;
            style?: "bullet" | "heading" | "normal" | undefined;
        })[];
    }, {
        heading: string;
        paragraphs: ({
            type: "image";
            ref: string;
            caption?: string | undefined;
            data?: string | undefined;
        } | {
            type: "paragraph";
            text: string;
            style?: "bullet" | "heading" | "normal" | undefined;
        })[];
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    schemaVersion: 1;
    title: string;
    sections: {
        heading: string;
        paragraphs: ({
            type: "image";
            ref: string;
            caption?: string | undefined;
            data?: string | undefined;
        } | {
            type: "paragraph";
            text: string;
            style?: "bullet" | "heading" | "normal" | undefined;
        })[];
    }[];
}, {
    schemaVersion: 1;
    title: string;
    sections: {
        heading: string;
        paragraphs: ({
            type: "image";
            ref: string;
            caption?: string | undefined;
            data?: string | undefined;
        } | {
            type: "paragraph";
            text: string;
            style?: "bullet" | "heading" | "normal" | undefined;
        })[];
    }[];
}>;
export type DocumentContent = z.infer<typeof documentContentSchema>;
export declare const tableContentSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    title: z.ZodString;
    headers: z.ZodArray<z.ZodString, "many">;
    rows: z.ZodArray<z.ZodArray<z.ZodString, "many">, "many">;
}, "strip", z.ZodTypeAny, {
    schemaVersion: 1;
    title: string;
    headers: string[];
    rows: string[][];
}, {
    schemaVersion: 1;
    title: string;
    headers: string[];
    rows: string[][];
}>;
export type TableContent = z.infer<typeof tableContentSchema>;
export declare const plotContentSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    type: z.ZodEnum<["bar", "line", "pie"]>;
    title: z.ZodString;
    x_label: z.ZodOptional<z.ZodString>;
    y_label: z.ZodOptional<z.ZodString>;
    series: z.ZodArray<z.ZodObject<{
        label: z.ZodString;
        x: z.ZodArray<z.ZodNumber, "many">;
        y: z.ZodArray<z.ZodNumber, "many">;
    }, "strip", z.ZodTypeAny, {
        label: string;
        x: number[];
        y: number[];
    }, {
        label: string;
        x: number[];
        y: number[];
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    schemaVersion: 1;
    type: "bar" | "line" | "pie";
    title: string;
    x_label?: string | undefined;
    y_label?: string | undefined;
    series: {
        label: string;
        x: number[];
        y: number[];
    }[];
}, {
    schemaVersion: 1;
    type: "bar" | "line" | "pie";
    title: string;
    x_label?: string | undefined;
    y_label?: string | undefined;
    series: {
        label: string;
        x: number[];
        y: number[];
    }[];
}>;
export type PlotContent = z.infer<typeof plotContentSchema>;
/**
 * #652: single job-type namespace. Values are what the control plane sends
 * (plugin-capability.service maps heurion/* tool names onto these) and what
 * the worker registers. Keep in sync with worker/src/server.ts HANDLERS.
 * #771: `sidecar.preview_file` — LibreOffice 渲染产物/上传 pptx 的翻页预览
 * 图（worker 端 soffice → pdf → pdftoppm PNG）；payload 不走 render-content
 * 校验（data_base64 直传文件字节）。
 */
export declare const renderJobType: z.ZodEnum<["sidecar.generate_pptx", "sidecar.generate_docx", "sidecar.render_table", "sidecar.render_plot", "sidecar.convert_to_pdf", "sidecar.preview_file", "sidecar.render_figure"]>;
export type RenderJobType = z.infer<typeof renderJobType>;
/**
 * #790: preview payload 单一形状来源 — 此前四份定义（contracts 注释 /
 * worker PreviewInput 手写接口 / server-ts 产出端内联字面量 / web 消费端
 * 手写类型），worker 端运行时靠 ad-hoc if 校验。data_base64 为文件字节
 * 直传，不经 render-content 契约（其余 jobType 的内容 schema 走
 * presentationContentSchema 等）。
 */
export declare const previewPayloadSchema: z.ZodObject<{
    data_base64: z.ZodString;
    file_name: z.ZodOptional<z.ZodString>;
    max_pages: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    data_base64: string;
    file_name?: string | undefined;
    max_pages?: number | undefined;
}, {
    data_base64: string;
    file_name?: string | undefined;
    max_pages?: number | undefined;
}>;
export type PreviewPayload = z.infer<typeof previewPayloadSchema>;
/**
 * #825: render_figure payload 单一形状来源(与 preview 同构 — 输入是
 * 用户/文档源码而非 LLM 产物,不走 render-content 契约)。
 * source ≤ 32KB(设计 §5 安全约束);产物 SVG 为准,导出侧按需光栅化。
 */
export declare const figurePayloadSchema: z.ZodObject<{
    kind: z.ZodEnum<["mermaid", "latex_math"]>;
    source: z.ZodString;
    display: z.ZodOptional<z.ZodBoolean>;
    theme: z.ZodOptional<z.ZodString>;
    scale: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    kind: "latex_math" | "mermaid";
    source: string;
    display?: boolean | undefined;
    theme?: string | undefined;
    scale?: number | undefined;
}, {
    kind: "latex_math" | "mermaid";
    source: string;
    display?: boolean | undefined;
    theme?: string | undefined;
    scale?: number | undefined;
}>;
export type FigurePayload = z.infer<typeof figurePayloadSchema>;
/**
 * #825: render_figure 结果形状 — 对齐 worker saveFile 产物(job-runner
 * 按 file_id 索引,控制面 fetchFile 取字节后自行落盘 fig_*.svg)。
 */
export declare const figureResultSchema: z.ZodObject<{
    file_id: z.ZodString;
    file_name: z.ZodString;
    mime_type: z.ZodString;
    width: z.ZodOptional<z.ZodNumber>;
    height: z.ZodOptional<z.ZodNumber>;
    warnings: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    file_id: string;
    file_name: string;
    mime_type: string;
    width?: number | undefined;
    height?: number | undefined;
    warnings?: string[] | undefined;
}, {
    file_id: string;
    file_name: string;
    mime_type: string;
    width?: number | undefined;
    height?: number | undefined;
    warnings?: string[] | undefined;
}>;
export type FigureResult = z.infer<typeof figureResultSchema>;
export type RenderContent = PresentationContent | DocumentContent | TableContent | PlotContent;
/**
 * Validate an AI-produced content payload for a job type. Returns
 * { ok: true, data } or { ok: false, errors } — the caller must retry the
 * LLM or fall back before the generator ever sees invalid input.
 */
export declare function validateRenderContent(type: string, raw: unknown): {
    ok: true;
    data: RenderContent;
} | {
    ok: false;
    errors: string[];
};
export declare const biosceneObjectSchema: z.ZodObject<{
    icon: z.ZodString;
    x: z.ZodNumber;
    y: z.ZodNumber;
    scale: z.ZodOptional<z.ZodNumber>;
    rotate: z.ZodOptional<z.ZodNumber>;
    label: z.ZodOptional<z.ZodString>;
    colorize: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    icon: string;
    x: number;
    y: number;
    scale?: number | undefined;
    rotate?: number | undefined;
    label?: string | undefined;
    colorize?: string | undefined;
}, {
    icon: string;
    x: number;
    y: number;
    scale?: number | undefined;
    rotate?: number | undefined;
    label?: string | undefined;
    colorize?: string | undefined;
}>;
export type BioSceneObject = z.infer<typeof biosceneObjectSchema>;
export declare const biosceneConnectionSchema: z.ZodObject<{
    from: z.ZodNumber;
    to: z.ZodNumber;
    kind: z.ZodOptional<z.ZodEnum<["arrow", "dashed", "phosphorylation", "inhibition"]>>;
    bend: z.ZodOptional<z.ZodNumber>;
    label: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    from: number;
    to: number;
    kind?: "arrow" | "dashed" | "inhibition" | "phosphorylation" | undefined;
    bend?: number | undefined;
    label?: string | undefined;
}, {
    from: number;
    to: number;
    kind?: "arrow" | "dashed" | "inhibition" | "phosphorylation" | undefined;
    bend?: number | undefined;
    label?: string | undefined;
}>;
export type BioSceneConnection = z.infer<typeof biosceneConnectionSchema>;
export declare const biosceneAnnotationSchema: z.ZodObject<{
    type: z.ZodEnum<["text", "bracket"]>;
    x: z.ZodNumber;
    y: z.ZodNumber;
    text: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "bracket" | "text";
    x: number;
    y: number;
    text: string;
}, {
    type: "bracket" | "text";
    x: number;
    y: number;
    text: string;
}>;
export type BioSceneAnnotation = z.infer<typeof biosceneAnnotationSchema>;
export declare const biosceneContentSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    canvas: z.ZodOptional<z.ZodObject<{
        width: z.ZodDefault<z.ZodNumber>;
        height: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        width: number;
        height: number;
    }, {
        width?: number | undefined;
        height?: number | undefined;
    }>>;
    objects: z.ZodArray<z.ZodObject<{
        icon: z.ZodString;
        x: z.ZodNumber;
        y: z.ZodNumber;
        scale: z.ZodOptional<z.ZodNumber>;
        rotate: z.ZodOptional<z.ZodNumber>;
        label: z.ZodOptional<z.ZodString>;
        colorize: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        icon: string;
        x: number;
        y: number;
        scale?: number | undefined;
        rotate?: number | undefined;
        label?: string | undefined;
        colorize?: string | undefined;
    }, {
        icon: string;
        x: number;
        y: number;
        scale?: number | undefined;
        rotate?: number | undefined;
        label?: string | undefined;
        colorize?: string | undefined;
    }>, "many">;
    connections: z.ZodOptional<z.ZodArray<z.ZodObject<{
        from: z.ZodNumber;
        to: z.ZodNumber;
        kind: z.ZodOptional<z.ZodEnum<["arrow", "dashed", "phosphorylation", "inhibition"]>>;
        bend: z.ZodOptional<z.ZodNumber>;
        label: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        from: number;
        to: number;
        kind?: "arrow" | "dashed" | "inhibition" | "phosphorylation" | undefined;
        bend?: number | undefined;
        label?: string | undefined;
    }, {
        from: number;
        to: number;
        kind?: "arrow" | "dashed" | "inhibition" | "phosphorylation" | undefined;
        bend?: number | undefined;
        label?: string | undefined;
    }>, "many">>;
    annotations: z.ZodOptional<z.ZodArray<z.ZodObject<{
        type: z.ZodEnum<["text", "bracket"]>;
        x: z.ZodNumber;
        y: z.ZodNumber;
        text: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "bracket" | "text";
        x: number;
        y: number;
        text: string;
    }, {
        type: "bracket" | "text";
        x: number;
        y: number;
        text: string;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    schemaVersion: 1;
    canvas?: {
        width: number;
        height: number;
    } | undefined;
    objects: {
        icon: string;
        x: number;
        y: number;
        scale?: number | undefined;
        rotate?: number | undefined;
        label?: string | undefined;
        colorize?: string | undefined;
    }[];
    connections?: {
        from: number;
        to: number;
        kind?: "arrow" | "dashed" | "inhibition" | "phosphorylation" | undefined;
        bend?: number | undefined;
        label?: string | undefined;
    }[] | undefined;
    annotations?: {
        type: "bracket" | "text";
        x: number;
        y: number;
        text: string;
    }[] | undefined;
}, {
    schemaVersion: 1;
    canvas?: {
        width?: number | undefined;
        height?: number | undefined;
    } | undefined;
    objects: {
        icon: string;
        x: number;
        y: number;
        scale?: number | undefined;
        rotate?: number | undefined;
        label?: string | undefined;
        colorize?: string | undefined;
    }[];
    connections?: {
        from: number;
        to: number;
        kind?: "arrow" | "dashed" | "inhibition" | "phosphorylation" | undefined;
        bend?: number | undefined;
        label?: string | undefined;
    }[] | undefined;
    annotations?: {
        type: "bracket" | "text";
        x: number;
        y: number;
        text: string;
    }[] | undefined;
}>;
export type BioSceneContent = z.infer<typeof biosceneContentSchema>;
