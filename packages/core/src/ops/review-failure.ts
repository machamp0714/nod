export interface ReviewReferenceDiagnostic {
  reason: "unknown_source" | "invalid_line" | "line_out_of_range";
  field: string;
  requirementUnitIndex: number | null;
  sourceIndex: number | null;
  sourceForm: "catalog_id" | "snapshot_path" | "id_without_type" | "unknown";
  matchedSourceIndex: number | null;
  line: number | null;
  lineCount: number | null;
}

/** 固定資料・担当出力の検査失敗。外部入力本文はエラーメッセージに含めない。 */
export class ReviewFailure extends Error {
  constructor(readonly code: string, message: string, readonly referenceDiagnostic?: ReviewReferenceDiagnostic) { super(message); }
}
