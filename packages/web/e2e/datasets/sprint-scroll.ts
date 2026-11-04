import { createIssue } from "@nod/core";
import { addActiveSprint } from "../../../core/test/fixtures/sprint";
import type { Dataset } from "../support/dataset";
import { loadLegacySprintDataset } from "../support/legacy-sprint-dataset";

// Sprint 詳細のスクロール復元。一覧がスクロールするだけの件数を、通常の Sprint 2つと移行済みの旧Cycle 1 に入れる。
// 旧Cycle 1（「過去」）は sprint-history と同じ旧版の移行で作り、移行前に Issue を足しておく。通常の Sprint は内部採択fixtureで作る
const SCROLL_COUNT = 40;
const STATUSES = ["backlog", "todo", "in_progress", "needs_clarification", "done"];
const pad = (n: number) => String(n).padStart(2, "0");

const dataset: Dataset = ({ db, dir }) => {
  loadLegacySprintDataset({ db, dir }, (legacy) => {
    const insert = legacy.query("INSERT INTO issues(id,workspace_id,number,title,status,priority,cycle_id,created_by,created_at,updated_at) VALUES(?,1,?,?,?,?,1,'me','2026-01-01','2026-10-01')");
    for (let i = 1; i <= SCROLL_COUNT; i++) insert.run(100 + i, 2 + i, `移行スクロール ${pad(i)}`, STATUSES[i % STATUSES.length]!, (i % 4) + 1);
    legacy.run("UPDATE workspaces SET next_number=? WHERE id=1", [3 + SCROLL_COUNT]);
  });
  const ctx = { db, actor: "me" };
  for (const [workspaceId, key, number] of [[1, "AAA", 15], [2, "BBB", 16]] as const) {
    const refs: string[] = [];
    for (let i = 1; i <= SCROLL_COUNT; i++) {
      const issue = createIssue(ctx, { workspaceId, title: `スクロール確認 ${key} ${pad(i)}` });
      db.query("UPDATE issues SET status=?, priority=? WHERE workspace_id=? AND number=?").run(STATUSES[i % STATUSES.length]!, (i % 4) + 1, workspaceId, issue.number);
      refs.push(issue.id);
    }
    addActiveSprint(db, workspaceId, number, refs);
  }
};

export default dataset;
