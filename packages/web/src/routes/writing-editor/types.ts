/** #696: writing-editor 拆分模块共享类型。 */
export interface DocDetail {
  id: string;
  title: string;
  body: string;
  /** #773: deck 资产（presentationContent JSON，可空）。 */
  deck?: unknown;
  /** #989 Phase 3: 块级结构投影 — 「编辑过程流式可见」的批次基线（缺失 null）。 */
  block_projection?: import('@heurion/contracts').BlockProjection | null | undefined;
  /** #996/#999: 节级作者/可信度标签（GET/PUT 响应随行；缺失降级不携带）。 */
  section_meta?: import('@heurion/contracts').SectionMetaMap;
  created_at: string;
  updated_at: string;
}

export interface SnapshotEntry {
  snapshot_id: string;
  created_at: string;
  body_preview: string;
}

export interface PhiFinding {
  start: number;
  end: number;
  text: string;
  suggestion: string;
}
