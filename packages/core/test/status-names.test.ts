import { describe, expect, test } from "bun:test";
import { initWorkspace } from "../src/ops/workspaces";
import {
  DEFAULT_STATUS_LABELS,
  getStatusNames,
  listAllStatusNames,
  setStatusNames,
  statusDisplayName,
} from "../src/status-names";
import { codeOf, setup } from "./helpers";

describe("ステータスの表示名", () => {
  test("既定の表示名は spec の英語名", () => {
    expect(DEFAULT_STATUS_LABELS).toEqual({
      triage: "Triage",
      backlog: "Backlog",
      needs_clarification: "Needs Clarification",
      todo: "Todo",
      in_progress: "In Progress",
      in_review: "In Review",
      done: "Done",
      canceled: "Canceled",
    });
  });

  test("未設定なら空で、表示は既定名", () => {
    const { db, ws } = setup();
    expect(getStatusNames(db, ws.key)).toEqual({ workspaceKey: ws.key, names: {} });
    expect(statusDisplayName("todo", {})).toBe("Todo");
  });

  test("人が設定すると前後の空白を落として保存し、空の値は既定に戻す", () => {
    const { db, ws, me } = setup();
    const saved = setStatusNames(me, ws.key, { todo: " 着手可 ", in_review: "確認待ち", done: " " });
    expect(saved).toEqual({ workspaceKey: ws.key, names: { todo: "着手可", in_review: "確認待ち" } });
    expect(getStatusNames(db, ws.key)).toEqual(saved);
    expect(statusDisplayName("todo", saved.names)).toBe("着手可");
    expect(statusDisplayName("done", saved.names)).toBe("Done");
  });

  test("保存は全体の置き換えで、渡さなかったステータスは既定に戻る", () => {
    const { db, ws, me } = setup();
    setStatusNames(me, ws.key, { todo: "着手可", in_review: "確認待ち" });
    setStatusNames(me, ws.key, { todo: "やる" });
    expect(getStatusNames(db, ws.key).names).toEqual({ todo: "やる" });
    setStatusNames(me, ws.key, {});
    expect(getStatusNames(db, ws.key).names).toEqual({});
  });

  test("既定名と同じ値は保存しない", () => {
    const { db, ws, me } = setup();
    setStatusNames(me, ws.key, { todo: "Todo" });
    expect(getStatusNames(db, ws.key).names).toEqual({});
  });

  test("未知のステータス・長すぎる名前・重複する名前は INVALID_ARGS", () => {
    const { ws, me } = setup();
    expect(codeOf(() => setStatusNames(me, ws.key, { ready: "x" } as never))).toBe("INVALID_ARGS");
    expect(codeOf(() => setStatusNames(me, ws.key, { todo: "x".repeat(31) }))).toBe("INVALID_ARGS");
    expect(codeOf(() => setStatusNames(me, ws.key, { todo: "同じ", backlog: "同じ" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => setStatusNames(me, ws.key, { todo: "Backlog" }))).toBe("INVALID_ARGS");
  });

  test("LLM は変更できず FORBIDDEN_FOR_LLM、読むことはできる", () => {
    const { db, ws, me, llm } = setup();
    expect(codeOf(() => setStatusNames(llm, ws.key, { todo: "x" }))).toBe("FORBIDDEN_FOR_LLM");
    setStatusNames(me, ws.key, { todo: "x" });
    expect(getStatusNames(db, ws.key).names).toEqual({ todo: "x" });
  });

  test("全 Workspace の表示名を Workspace のキーごとに返す", () => {
    const { db, ws, me } = setup();
    const other = initWorkspace(db, { path: "/tmp/repos/web-app" }).workspace;
    setStatusNames(me, ws.key, { todo: "着手可" });
    expect(listAllStatusNames(db)).toEqual({ [ws.key]: { todo: "着手可" }, [other.key]: {} });
  });

  test("未登録の Workspace は NOT_FOUND", () => {
    const { db, me } = setup();
    expect(codeOf(() => getStatusNames(db, "NOPE"))).toBe("NOT_FOUND");
    expect(codeOf(() => setStatusNames(me, "NOPE", {}))).toBe("NOT_FOUND");
  });

  test("DB の CHECK 制約で未知のステータスは保存できない", () => {
    const { db, ws } = setup();
    expect(() =>
      db.query("INSERT INTO workspace_status_names (workspace_id, status, name) VALUES (?, 'ready', 'x')").run(ws.id),
    ).toThrow();
  });
});
