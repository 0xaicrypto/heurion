/** #696: writing-editor 拆分模块共享类型。 */
export interface DocDetail {
  id: string;
  title: string;
  body: string;
  /** #773: deck 资产（presentationContent JSON，可空）。 */
  deck?: unknown;
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
