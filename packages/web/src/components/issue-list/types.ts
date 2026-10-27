import type { Issue } from "../../api/types";
import type { QuestionCount } from "../../lib/format";

// Issue 一覧の1行。ready と questions は core の Issue にないため、E が API の応答からこの形を作る。
export interface IssueListRow {
  issue: Issue;
  questions: QuestionCount;
  ready: boolean;
  workspaceName: string;
  // 親キーが未記録の移行履歴でも、子であるという取得済みの事実は保持する。
  hasParent?: boolean;
}
