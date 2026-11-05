import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { archiveIssue, deleteIssue, getSprint, openDb, updateIssue } from "@nod/core";
import { legacySprintFixture } from "../../../core/test/fixtures/sprint";
import { tempDbPath } from "../../../core/test/helpers";
import type { Sprint, SprintReference } from "../api/types";
import { sprintAssociationLabel, sprintPicker, sprintSnapshotRows } from "./sprints";

test("履歴の親キーは保存済みの根拠だけから読み、期間外の親キーを推定しない", () => {
  const path = tempDbPath(); legacySprintFixture(path);
  const old = new Database(path);
  old.exec(`UPDATE issues SET parent_id=3 WHERE id=1;
    UPDATE issues SET parent_id=1 WHERE id=2;`);
  old.close();
  const db = openDb(path);
  updateIssue({db,actor:"me"}, "BBB-1", {parentRef:null});
  archiveIssue({db,actor:"me"}, "AAA-1"); deleteIssue({db,actor:"me"}, "AAA-1");
  const rows = sprintSnapshotRows(getSprint(db,"1"));
  expect(rows.map(row => [row.issue.id,row.issue.parentId,row.hasParent])).toEqual([
    ["AAA-1",null,true], ["BBB-1","AAA-1",true],
  ]);
  db.close();
});

test("Sprintの由来は移行を「移行履歴」、追加を「追加」、計画の採択を「採択」と表示する", () => {
  expect(sprintAssociationLabel("imported")).toBe("移行履歴");
  expect(sprintAssociationLabel("added")).toBe("追加");
  expect(sprintAssociationLabel("adopted")).toBe("採択");
});

// Issue 詳細の Sprint のピル（NOD-56）。一覧の Sprint は必要な項目だけを書く
const sprint = (patch: Partial<Sprint> & Pick<Sprint, "id" | "number" | "phase">): Sprint => ({
  workspaceId: 1, name: `Sprint ${patch.number}`, startDate: "2026-11-01", endDate: "2026-11-14", timezone: "UTC",
  startsAt: null, endsAt: "2026-11-15T00:00:00.000Z", adoptedPlanId: null, goal: null, definitionOfDone: null, outcome: null,
  legacyCycleId: null, createdAt: "2026-11-01", updatedAt: "2026-11-01", version: 1, workingDays: [1, 2, 3, 4, 5],
  workspaceSnapshot: null, activatedAt: null, canceledAt: null, cancelReason: null, replansSprintId: null, rolloverFromSprintId: null, activatedBy: null, ...patch,
});
const member = (patch: Partial<SprintReference> & Pick<SprintReference, "id" | "phase">): SprintReference => ({
  number: 1, name: patch.id, workspaceId: 1, association: "added", inAdoptedPlan: false, ...patch,
});
const NOW = Date.parse("2026-11-20T00:00:00.000Z");

test("Sprintのピルは同じWorkspaceの開いているSprintを進行中・準備完了・下書きの順に、開始日と番号の順で並べ、期限を過ぎた進行中に期限超過を付ける", () => {
  const sprints = [
    sprint({ id: "d", number: 9, phase: "draft", startDate: "2026-11-01" }),
    sprint({ id: "r2", number: 8, phase: "ready", startDate: "2026-12-01" }),
    sprint({ id: "r1", number: 7, phase: "ready", startDate: "2026-11-15" }),
    sprint({ id: "a2", number: 6, phase: "active", startDate: "2026-11-01", endsAt: "2026-12-01T00:00:00.000Z" }),
    sprint({ id: "a1", number: 5, phase: "active", startDate: "2026-11-01" }),
    sprint({ id: "other", number: 4, phase: "active", workspaceId: 2 }),
    sprint({ id: "deleted", number: 3, phase: "draft", workspaceId: null, workspaceSnapshot: { id: 1, key: "AAA", name: "A" } }),
    sprint({ id: "ended", number: 2, phase: "ended" }),
    sprint({ id: "imported", number: 1, phase: "imported" }),
  ];
  const picker = sprintPicker([], sprints, 1, NOW);
  expect(picker.choices.map((c) => [c.id, c.overdue])).toEqual([["a1", true], ["a2", false], ["r1", false], ["r2", false], ["d", false]]);
  expect(picker).toMatchObject({ value: "", label: "なし", noneDisabled: false, locked: false, blockedBy: [] });
  expect(picker.choices.every((c) => !c.disabled)).toBe(true);
  // Workspace の ID が分からない間は項目を出さない
  expect(sprintPicker([], sprints, null, NOW).choices).toEqual([]);
});

test("Sprintのピルの値は開いている所属が1件ならそのSprint、0件ならなし、2件以上なら件数で、閉じた所属は数えない", () => {
  const closed = [member({ id: "old", phase: "imported", association: "imported" }), member({ id: "end", phase: "ended", inAdoptedPlan: true })];
  expect(sprintPicker(closed, [], 1, NOW)).toMatchObject({ value: "", label: "なし", locked: false, noneDisabled: false });
  expect(sprintPicker([...closed, member({ id: "a", name: "実行 12", phase: "active" })], [], 1, NOW)).toMatchObject({ value: "a", label: "実行 12" });
  const two = sprintPicker([member({ id: "a", phase: "active" }), member({ id: "d", phase: "draft" })], [], 1, NOW);
  expect(two.value).not.toBe("");
  expect([two.value === "a", two.value === "d", two.label]).toEqual([false, false, "2 件の Sprint"]);
});

test("Sprintのピルは開いている所属の採択が1件ならそのSprintだけを選べ、2件以上なら操作できず、外せない理由のSprint名を返す", () => {
  const sprints = [sprint({ id: "a", number: 1, phase: "active" }), sprint({ id: "d", number: 2, phase: "draft" })];
  const one = sprintPicker([member({ id: "a", name: "実行 12", phase: "active", association: "adopted", inAdoptedPlan: true }), member({ id: "d", phase: "draft" })], sprints, 1, NOW);
  expect(one.choices.map((c) => [c.id, c.disabled])).toEqual([["a", false], ["d", true]]);
  expect(one).toMatchObject({ noneDisabled: true, locked: false, blockedBy: ["実行 12"] });
  const both = sprintPicker([member({ id: "a", name: "実行 12", phase: "active", inAdoptedPlan: true }), member({ id: "d", name: "次", phase: "draft", inAdoptedPlan: true })], sprints, 1, NOW);
  expect(both).toMatchObject({ locked: true, noneDisabled: true, blockedBy: ["実行 12", "次"] });
  // 閉じた Sprint の採択は外す対象ではないため、選べる項目を減らさない
  const closed = sprintPicker([member({ id: "end", phase: "ended", inAdoptedPlan: true })], sprints, 1, NOW);
  expect(closed).toMatchObject({ noneDisabled: false, locked: false, blockedBy: [] });
  expect(closed.choices.every((c) => !c.disabled)).toBe(true);
});
