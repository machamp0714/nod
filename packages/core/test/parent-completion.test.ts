import { describe, expect, test } from "bun:test";
import { approveReview } from "../src/ops/human";
import { createIssue, getIssue, listIssues, queryIssues, updateIssue } from "../src/ops/issues";
import { codeOf, setup } from "./helpers";

function family(statuses: ("done" | "canceled" | "todo" | "in_progress")[]) {
  const t = setup();
  const parent = createIssue(t.me, { workspaceId: t.ws.id, title: "親" });
  for (const status of statuses) {
    const child = createIssue(t.me, { workspaceId: t.ws.id, title: "子", parentRef: parent.id });
    updateIssue(t.me, child.id, { status });
  }
  return { ...t, parent };
}

const candidate = (t: ReturnType<typeof family>) => getIssue(t.db, t.parent.id).completionCandidate;

describe("親の完了候補", () => {
  test("直接の子がすべて done/canceled で done が1件以上なら候補になる", () => {
    expect(candidate(family(["done"]))).toBe(true);
    expect(candidate(family(["done", "canceled"]))).toBe(true);
  });

  test("未完了の子が残る・子が無い・canceled のみのときは候補にならない", () => {
    expect(candidate(family(["done", "in_progress"]))).toBe(false);
    expect(candidate(family(["done", "todo"]))).toBe(false);
    expect(candidate(family([]))).toBe(false);
    expect(candidate(family(["canceled", "canceled"]))).toBe(false);
  });

  test("親自身が done・canceled・triage なら候補にならない", () => {
    for (const status of ["done", "canceled"] as const) {
      const t = family(["done"]);
      updateIssue(t.me, t.parent.id, { status });
      expect(candidate(t)).toBe(false);
    }
    const t = setup();
    const triaged = createIssue(t.llm, { workspaceId: t.ws.id, title: "LLM の起票" });
    const child = createIssue(t.me, { workspaceId: t.ws.id, title: "子", parentRef: triaged.id });
    updateIssue(t.me, child.id, { status: "done" });
    expect(getIssue(t.db, triaged.id)).toMatchObject({ status: "triage", completionCandidate: false });
  });

  test("孫は見ず、直接の子だけで判定する", () => {
    const t = family(["done"]);
    const child = getIssue(t.db, t.parent.id).children[0]!;
    createIssue(t.me, { workspaceId: t.ws.id, title: "孫", parentRef: child.id });
    expect(candidate(t)).toBe(true);
  });

  test("一覧でも同じ値を返し、completionCandidate で候補だけに絞れる", () => {
    const t = family(["done"]);
    createIssue(t.me, { workspaceId: t.ws.id, title: "無関係" });
    const listed = listIssues(t.db, { workspaceId: t.ws.id });
    expect(listed.find((i) => i.id === t.parent.id)?.completionCandidate).toBe(true);
    expect(listed.filter((i) => i.id !== t.parent.id).every((i) => !i.completionCandidate)).toBe(true);
    expect(listIssues(t.db, { workspaceId: t.ws.id, completionCandidate: true }).map((i) => i.id)).toEqual([t.parent.id]);
    expect(queryIssues(t.db, {}).issues.find((i) => i.id === t.parent.id)?.completionCandidate).toBe(true);
  });

  test("LLM は候補を読めるが、既存の保護により done にも承認にもできない", () => {
    const t = family(["done"]);
    expect(getIssue(t.db, t.parent.id).completionCandidate).toBe(true);
    expect(codeOf(() => updateIssue(t.llm, t.parent.id, { status: "done" }))).toBe("FORBIDDEN_FOR_LLM");
    updateIssue(t.me, t.parent.id, { status: "in_review" });
    expect(codeOf(() => approveReview(t.llm, t.parent.id))).toBe("FORBIDDEN_FOR_LLM");
    expect(getIssue(t.db, t.parent.id)).toMatchObject({ status: "in_review", completionCandidate: true });
  });

  test("人が既存の経路で完了すると候補から外れる", () => {
    const t = family(["done"]);
    updateIssue(t.me, t.parent.id, { status: "done" });
    expect(getIssue(t.db, t.parent.id)).toMatchObject({ status: "done", completionCandidate: false });
    const r = family(["done"]);
    updateIssue(r.me, r.parent.id, { status: "in_review" });
    expect(approveReview(r.me, r.parent.id)).toMatchObject({ status: "done", completionCandidate: false });
  });

  test("子が再び開くと候補から外れる", () => {
    const t = family(["done"]);
    const child = getIssue(t.db, t.parent.id).children[0]!;
    updateIssue(t.me, child.id, { status: "in_progress" });
    expect(candidate(t)).toBe(false);
  });
});
