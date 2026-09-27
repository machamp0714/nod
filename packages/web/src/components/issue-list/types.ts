import type { Issue } from "../../api/types";
import type { QuestionCount } from "../../lib/format";

// Issue 一覧の1行。ready と questions は core の Issue にないため、E が API の応答からこの形を作る。
export interface IssueListRow {
  issue: Issue;
  questions: QuestionCount;
  ready: boolean;
  workspaceName: string;
}
