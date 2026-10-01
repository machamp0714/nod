import { describe, expect, test } from "bun:test";
import type { NodError } from "../src/errors";
import { askQuestion, nextIssue, startIssue } from "../src/ops/agent";
import { bulkUpdateIssues } from "../src/ops/bulk-update";
import { acceptTriage, answerQuestion, getInbox } from "../src/ops/human";
import { createIssue, getIssue, updateIssue } from "../src/ops/issues";
import { codeOf, eventsOf, setup } from "./helpers";

const statusChanges = (db: Parameters<typeof eventsOf>[0], ref: string) =>
  eventsOf(db, ref)
    .filter((e) => e.type === "status_changed")
    .map((e) => e.data);

describe("Needs Clarification への自動の切り替え", () => {
  test("todo の Issue に未決事項を足すと needs_clarification になり、すべて決めると todo に戻る", () => {
    const { db, ws, me } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    const first = askQuestion(me, i.id, "対象の画面はどれか");
    const second = askQuestion(me, i.id, "期限はいつか");
    expect(first.issue).toMatchObject({ status: "needs_clarification", agentState: null });
    answerQuestion(me, i.id, "一覧", { questionId: first.question.id });
    expect(getIssue(db, i.id).status).toBe("needs_clarification");
    const r = answerQuestion(me, i.id, "来週", { questionId: second.question.id });
    expect(r.issue.status).toBe("todo");
    expect(statusChanges(db, i.id)).toEqual([
      { from: "todo", to: "needs_clarification" },
      { from: "needs_clarification", to: "todo" },
    ]);
    expect(getIssue(db, i.id).questions.map((q) => [q.question, q.answer])).toEqual([
      ["対象の画面はどれか", "一覧"],
      ["期限はいつか", "来週"],
    ]);
  });

  test("backlog から入った Issue は backlog に戻る", () => {
    const { ws, me } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    updateIssue(me, i.id, { status: "backlog" });
    const asked = askQuestion(me, i.id, "やるかどうか");
    expect(asked.issue.status).toBe("needs_clarification");
    expect(answerQuestion(me, i.id, "やる", { questionId: asked.question.id }).issue.status).toBe("backlog");
  });

  test("LLM が todo の Issue に確認を求めても needs_clarification にし、作業状況は変えない", () => {
    const { ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    expect(askQuestion(llm, i.id, "どちらの方式にするか").issue).toMatchObject({
      status: "needs_clarification",
      agentState: null,
    });
  });

  test("未決事項のある Triage の Issue は Triage のままで、受け入れると needs_clarification、決めると todo になる", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(llm, { workspaceId: ws.id, title: "t" });
    const asked = askQuestion(me, i.id, "本当に要るか");
    expect(asked.issue.status).toBe("triage");
    expect(acceptTriage(me, i.id).status).toBe("needs_clarification");
    expect(answerQuestion(me, i.id, "要る", { questionId: asked.question.id }).issue.status).toBe("todo");
    expect(statusChanges(db, i.id)).toEqual([
      { from: "triage", to: "todo" },
      { from: "todo", to: "needs_clarification" },
      { from: "needs_clarification", to: "todo" },
    ]);
  });

  test("in_progress の Issue では、LLM の確認依頼は作業状況を awaiting_input にし、私の確認依頼は何も変えない", () => {
    const { ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    startIssue(llm, i.id);
    expect(askQuestion(me, i.id, "ついでに直すか").issue).toMatchObject({ status: "in_progress", agentState: "working" });
    expect(askQuestion(llm, i.id, "--force を外してよいか").issue).toMatchObject({
      status: "in_progress",
      agentState: "awaiting_input",
    });
  });

  test("needs_clarification の Issue は next で取られず、start は NEEDS_CLARIFICATION になる", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    askQuestion(me, i.id, "対象はどれか");
    expect(nextIssue(llm, { workspaceId: ws.id })).toBeNull();
    expect(codeOf(() => startIssue(llm, i.id))).toBe("NEEDS_CLARIFICATION");
    expect(getIssue(db, i.id).status).toBe("needs_clarification");
  });

  test("同じ文面の未決事項は増やさず、ステータスもそのまま", () => {
    const { db, ws, me } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    askQuestion(me, i.id, "対象はどれか");
    const again = askQuestion(me, i.id, "対象はどれか");
    expect(again).toMatchObject({ created: false, issue: { status: "needs_clarification" } });
    expect(eventsOf(db, i.id).filter((e) => e.type === "question_asked")).toHaveLength(1);
    expect(statusChanges(db, i.id)).toHaveLength(1);
  });
});

describe("未決事項が残る Issue の手動の状態変更（#170）", () => {
  for (const to of ["todo", "backlog"] as const) {
    test(`人が needs_clarification から ${to} に移すと、そのまま ${to} になり、event は1件だけ残る`, () => {
      const { db, ws, me } = setup();
      const i = createIssue(me, { workspaceId: ws.id, title: "t" });
      askQuestion(me, i.id, "対象はどれか");
      const before = statusChanges(db, i.id).length;
      expect(updateIssue(me, i.id, { status: to }).status).toBe(to);
      expect(statusChanges(db, i.id).slice(before)).toEqual([{ from: "needs_clarification", to }]);
      expect(getIssue(db, i.id)).toMatchObject({ status: to, openQuestions: [{ question: "対象はどれか" }] });
    });
  }

  test("人が in_progress から todo・backlog に戻しても、needs_clarification に切り替えない", () => {
    const { db, ws, me } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    updateIssue(me, i.id, { status: "in_progress" });
    askQuestion(me, i.id, "対象はどれか");
    expect(updateIssue(me, i.id, { status: "backlog" }).status).toBe("backlog");
    expect(updateIssue(me, i.id, { status: "todo" }).status).toBe("todo");
    expect(statusChanges(db, i.id)).toEqual([
      { from: "todo", to: "in_progress" },
      { from: "in_progress", to: "backlog" },
      { from: "backlog", to: "todo" },
    ]);
  });

  test("手で todo に出した Issue は、未回答が残る間は着手できず、すべて回答しても状態は変わらない", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    const asked = askQuestion(llm, i.id, "どちらの方式にするか");
    updateIssue(me, i.id, { status: "todo" });
    expect(nextIssue(llm, { workspaceId: ws.id })).toBeNull();
    expect(codeOf(() => startIssue(llm, i.id))).toBe("AWAITING_ANSWER");
    const before = statusChanges(db, i.id).length;
    expect(answerQuestion(me, i.id, "A 方式", { questionId: asked.question.id }).issue.status).toBe("todo");
    expect(statusChanges(db, i.id)).toHaveLength(before);
    expect(nextIssue(llm, { workspaceId: ws.id })?.id).toBe(i.id);
  });

  test("手で backlog に出した Issue に新しい確認依頼が付くと needs_clarification になり、回答すると backlog に戻る", () => {
    const { ws, me } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    const first = askQuestion(me, i.id, "対象はどれか");
    updateIssue(me, i.id, { status: "backlog" });
    const second = askQuestion(me, i.id, "期限はいつか");
    expect(second.issue.status).toBe("needs_clarification");
    answerQuestion(me, i.id, "一覧", { questionId: first.question.id });
    expect(answerQuestion(me, i.id, "来週", { questionId: second.question.id }).issue.status).toBe("backlog");
  });

  for (const to of ["todo", "backlog"] as const) {
    test(`人が ${to} に出したあと、同じ文面の ask を再実行しても ${to} のままで、新しい質問なら needs_clarification になる`, () => {
      const { db, ws, me, llm } = setup();
      const i = createIssue(me, { workspaceId: ws.id, title: "t" });
      askQuestion(llm, i.id, "どちらの方式にするか");
      updateIssue(me, i.id, { status: to });
      const before = eventsOf(db, i.id);
      const again = askQuestion(llm, i.id, "どちらの方式にするか");
      expect(again).toMatchObject({ created: false, issue: { status: to } });
      expect(eventsOf(db, i.id)).toEqual(before);
      const added = askQuestion(llm, i.id, "期限はいつか");
      expect(added).toMatchObject({ created: true, issue: { status: "needs_clarification" } });
      expect(statusChanges(db, i.id).at(-1)).toEqual({ from: to, to: "needs_clarification" });
    });
  }

  test("LLM が in_progress から todo に戻しても、me の未回答が残っていて needs_clarification に切り替えない", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    updateIssue(me, i.id, { status: "in_progress" });
    askQuestion(me, i.id, "対象はどれか");
    expect(updateIssue(llm, i.id, { status: "todo" }).status).toBe("todo");
    expect(statusChanges(db, i.id)).toEqual([
      { from: "todo", to: "in_progress" },
      { from: "in_progress", to: "todo" },
    ]);
    expect(getIssue(db, i.id)).toMatchObject({ status: "todo", openQuestions: [{ question: "対象はどれか" }] });
  });

  test("回答済みの質問と同じ文面で ask すると、新しい質問になり needs_clarification に入る", () => {
    const { db, ws, me } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    const first = askQuestion(me, i.id, "対象はどれか");
    expect(answerQuestion(me, i.id, "一覧", { questionId: first.question.id }).issue.status).toBe("todo");
    const again = askQuestion(me, i.id, "対象はどれか");
    expect(again).toMatchObject({ created: true, issue: { status: "needs_clarification" } });
    expect(again.question.id).not.toBe(first.question.id);
    expect(eventsOf(db, i.id).filter((e) => e.type === "question_asked")).toHaveLength(2);
    expect(statusChanges(db, i.id).at(-1)).toEqual({ from: "todo", to: "needs_clarification" });
  });

  test("backlog から needs_clarification に入って手で todo に出たあと、再び入ると戻り先は todo", () => {
    const { db, ws, me } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    updateIssue(me, i.id, { status: "backlog" });
    const first = askQuestion(me, i.id, "対象はどれか");
    expect(statusChanges(db, i.id).at(-1)).toEqual({ from: "backlog", to: "needs_clarification" });
    updateIssue(me, i.id, { status: "todo" });
    const second = askQuestion(me, i.id, "期限はいつか");
    expect(statusChanges(db, i.id).at(-1)).toEqual({ from: "todo", to: "needs_clarification" });
    answerQuestion(me, i.id, "一覧", { questionId: first.question.id });
    expect(answerQuestion(me, i.id, "来週", { questionId: second.question.id }).issue.status).toBe("todo");
  });

  describe("LLM は、me の未決事項が未回答の間は needs_clarification から出せない", () => {
    for (const to of ["todo", "backlog", "triage", "in_progress", "in_review"] as const) {
      test(`${to} にしようとすると FORBIDDEN_FOR_LLM で、何も書かない`, () => {
        const { db, ws, me, llm } = setup();
        const i = createIssue(me, { workspaceId: ws.id, title: "t" });
        askQuestion(me, i.id, "対象はどれか");
        const before = { issue: getIssue(db, i.id), events: eventsOf(db, i.id) };
        expect(codeOf(() => updateIssue(llm, i.id, { status: to, priority: 1 }))).toBe("FORBIDDEN_FOR_LLM");
        expect({ issue: getIssue(db, i.id), events: eventsOf(db, i.id) }).toEqual(before);
      });
    }

    test("me と LLM の質問が混ざっていても、me の未回答が残る間は出せない", () => {
      const { db, ws, me, llm } = setup();
      const i = createIssue(me, { workspaceId: ws.id, title: "t" });
      const mine = askQuestion(me, i.id, "対象はどれか");
      askQuestion(llm, i.id, "どちらの方式にするか");
      expect(codeOf(() => updateIssue(llm, i.id, { status: "todo" }))).toBe("FORBIDDEN_FOR_LLM");
      // me の未決事項が決まれば、LLM の質問だけが残るので人と同じ扱いになる
      answerQuestion(me, i.id, "一覧", { questionId: mine.question.id });
      expect(updateIssue(llm, i.id, { status: "todo" }).status).toBe("todo");
      expect(getIssue(db, i.id).openQuestions.map((q) => q.question)).toEqual(["どちらの方式にするか"]);
    });

    test("LLM の質問だけが残るなら、人と同じく todo に出せる（event は1件）", () => {
      const { db, ws, me, llm } = setup();
      const i = createIssue(me, { workspaceId: ws.id, title: "t" });
      askQuestion(llm, i.id, "どちらの方式にするか");
      const before = statusChanges(db, i.id).length;
      expect(updateIssue(llm, i.id, { status: "todo" }).status).toBe("todo");
      expect(statusChanges(db, i.id).slice(before)).toEqual([{ from: "needs_clarification", to: "todo" }]);
    });

    test("canceled にはでき、状態以外の項目は変えられる", () => {
      const { ws, me, llm } = setup();
      const i = createIssue(me, { workspaceId: ws.id, title: "t" });
      askQuestion(me, i.id, "対象はどれか");
      expect(updateIssue(llm, i.id, { priority: 2 })).toMatchObject({ status: "needs_clarification", priority: 2 });
      expect(updateIssue(llm, i.id, { status: "canceled" }).status).toBe("canceled");
    });

    // 人が needs_clarification から出したあとも、人が決める前に LLM が着手の状態にできないようにする
    for (const from of ["todo", "backlog"] as const) {
      for (const to of ["in_progress", "in_review"] as const) {
        test(`人が ${from} に出したあとも、${to} にしようとすると FORBIDDEN_FOR_LLM で、何も書かない`, () => {
          const { db, ws, me, llm } = setup();
          const i = createIssue(me, { workspaceId: ws.id, title: "t" });
          askQuestion(me, i.id, "対象はどれか");
          updateIssue(me, i.id, { status: from });
          const before = { issue: getIssue(db, i.id), events: eventsOf(db, i.id) };
          expect(codeOf(() => updateIssue(llm, i.id, { status: to, priority: 1 }))).toBe("FORBIDDEN_FOR_LLM");
          expect({ issue: getIssue(db, i.id), events: eventsOf(db, i.id) }).toEqual(before);
          // 人は未回答を残したまま進められる
          expect(updateIssue(me, i.id, { status: to }).status).toBe(to);
        });
      }
    }

    test("人が todo に出したあとの todo と backlog の間の移動は、着手にならないので LLM にもできる", () => {
      const { ws, me, llm } = setup();
      const i = createIssue(me, { workspaceId: ws.id, title: "t" });
      askQuestion(me, i.id, "対象はどれか");
      updateIssue(me, i.id, { status: "todo" });
      expect(updateIssue(llm, i.id, { status: "backlog" }).status).toBe("backlog");
      expect(updateIssue(llm, i.id, { status: "todo" }).status).toBe("todo");
    });

    // canceled は通すので、canceled を経由して着手の状態にする2手の迂回を塞ぐ
    for (const to of ["in_progress", "in_review"] as const) {
      test(`canceled にしたあと ${to} にしようとすると FORBIDDEN_FOR_LLM で、何も書かない`, () => {
        const { db, ws, me, llm } = setup();
        const i = createIssue(me, { workspaceId: ws.id, title: "t" });
        askQuestion(me, i.id, "対象はどれか");
        expect(updateIssue(llm, i.id, { status: "canceled" }).status).toBe("canceled");
        const before = { issue: getIssue(db, i.id), events: eventsOf(db, i.id) };
        expect(codeOf(() => updateIssue(llm, i.id, { status: to, priority: 1 }))).toBe("FORBIDDEN_FOR_LLM");
        expect(codeOf(() => bulkUpdateIssues(llm, [i.id], { status: to }))).toBe("BULK_UPDATE_FAILED");
        expect({ issue: getIssue(db, i.id), events: eventsOf(db, i.id) }).toEqual(before);
        // 着手前の状態には戻せるが、そこからも着手の状態にはできない
        expect(updateIssue(llm, i.id, { status: "todo" }).status).toBe("todo");
        expect(codeOf(() => updateIssue(llm, i.id, { status: to }))).toBe("FORBIDDEN_FOR_LLM");
        expect(codeOf(() => startIssue(llm, i.id))).toBe("AWAITING_ANSWER");
        // 人は未回答を残したまま進められる
        expect(updateIssue(me, i.id, { status: to }).status).toBe(to);
      });
    }

    test("人が done にした Issue も、me の未回答が残る間は LLM が in_progress に戻せない", () => {
      const { ws, me, llm } = setup();
      const i = createIssue(me, { workspaceId: ws.id, title: "t" });
      askQuestion(me, i.id, "対象はどれか");
      updateIssue(me, i.id, { status: "done" });
      expect(codeOf(() => updateIssue(llm, i.id, { status: "in_progress" }))).toBe("FORBIDDEN_FOR_LLM");
    });

    test("作業中に me が足した未決事項は、in_review と in_progress の間の移動を止めない", () => {
      const { ws, me, llm } = setup();
      const i = createIssue(me, { workspaceId: ws.id, title: "t" });
      startIssue(llm, i.id);
      askQuestion(me, i.id, "ついでに直すか");
      expect(updateIssue(llm, i.id, { status: "in_review" }).status).toBe("in_review");
      expect(updateIssue(llm, i.id, { status: "in_progress" }).status).toBe("in_progress");
    });

    test("LLM は answer で me の未決事項を閉じてガードを外すことはできない（#172）", () => {
      const { db, ws, me, llm } = setup();
      const i = createIssue(me, { workspaceId: ws.id, title: "t" });
      const mine = askQuestion(me, i.id, "対象はどれか").question;
      updateIssue(me, i.id, { status: "todo" });
      expect(codeOf(() => answerQuestion(llm, i.id, "一覧", { questionId: mine.id }))).toBe("FORBIDDEN_FOR_LLM");
      expect(codeOf(() => answerQuestion(llm, i.id, "一覧"))).toBe("NO_OPEN_QUESTION");
      expect(getIssue(db, i.id).openQuestions.map((q) => q.id)).toEqual([mine.id]);
      expect(codeOf(() => updateIssue(llm, i.id, { status: "in_progress" }))).toBe("FORBIDDEN_FOR_LLM");
      expect(codeOf(() => startIssue(llm, i.id))).toBe("AWAITING_ANSWER");
      // me が決めれば進められる
      answerQuestion(me, i.id, "一覧", { questionId: mine.id });
      expect(updateIssue(llm, i.id, { status: "in_progress" }).status).toBe("in_progress");
    });

    test("一括編集でも失敗一覧に FORBIDDEN_FOR_LLM が入り、1件も書かない", () => {
      const { db, ws, me, llm } = setup();
      const ok = createIssue(me, { workspaceId: ws.id, title: "ok" });
      const held = createIssue(me, { workspaceId: ws.id, title: "held" });
      askQuestion(me, held.id, "対象はどれか");
      const before = db.query("SELECT * FROM events ORDER BY id").all();
      let error: NodError | undefined;
      try {
        bulkUpdateIssues(llm, [ok.id, held.id], { status: "in_progress", priority: 1 });
      } catch (e) {
        error = e as NodError;
      }
      expect(error?.code).toBe("BULK_UPDATE_FAILED");
      expect(error?.details).toEqual({ failures: [{ id: held.id, code: "FORBIDDEN_FOR_LLM", message: expect.any(String) }] });
      expect(db.query("SELECT * FROM events ORDER BY id").all()).toEqual(before);
      expect(getIssue(db, held.id).status).toBe("needs_clarification");
    });
  });
});

describe("answerQuestion の対象", () => {
  test("既定では LLM の質問だけに答え、私の未決事項は残す", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    startIssue(llm, i.id);
    askQuestion(me, i.id, "私の未決事項");
    askQuestion(llm, i.id, "LLM の質問");
    const r = answerQuestion(me, i.id, "よい");
    expect(r.answered.map((q) => q.question)).toEqual(["LLM の質問"]);
    expect(r.issue.agentState).toBe("working");
    expect(getIssue(db, i.id).openQuestions.map((q) => q.question)).toEqual(["私の未決事項"]);
  });

  test("LLM の質問がなく私の未決事項だけなら NO_OPEN_QUESTION で --question を案内し、何も変えない", () => {
    const { db, ws, me } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    askQuestion(me, i.id, "対象はどれか");
    let message = "";
    try {
      answerQuestion(me, i.id, "一覧");
    } catch (e) {
      expect((e as { code: string }).code).toBe("NO_OPEN_QUESTION");
      message = (e as Error).message;
    }
    expect(message).toContain("--question");
    const detail = getIssue(db, i.id);
    expect(detail.status).toBe("needs_clarification");
    expect(detail.openQuestions).toHaveLength(1);
  });

  test("--question は指定した質問だけに答え、別の Issue の質問は NOT_FOUND、回答済みは NO_OPEN_QUESTION", () => {
    const { ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b" });
    const qa = askQuestion(me, a.id, "a の質問").question;
    const qb = askQuestion(me, b.id, "b の質問").question;
    expect(codeOf(() => answerQuestion(me, a.id, "x", { questionId: qb.id }))).toBe("NOT_FOUND");
    expect(answerQuestion(me, a.id, "決めた", { questionId: qa.id }).answered).toEqual([
      expect.objectContaining({ id: qa.id, answer: "決めた", answeredBy: "me" }),
    ]);
    expect(codeOf(() => answerQuestion(me, a.id, "もう一度", { questionId: qa.id }))).toBe("NO_OPEN_QUESTION");
  });

  test("LLM の質問が残っている間は awaiting_input のまま", () => {
    const { ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    startIssue(llm, i.id);
    const q1 = askQuestion(llm, i.id, "一つ目").question;
    const q2 = askQuestion(llm, i.id, "二つ目").question;
    expect(answerQuestion(me, i.id, "よい", { questionId: q1.id }).issue.agentState).toBe("awaiting_input");
    expect(answerQuestion(me, i.id, "よい", { questionId: q2.id }).issue.agentState).toBe("working");
  });
});

describe("人が付けた未決事項への LLM の回答（#172）", () => {
  const messageOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e) {
      return (e as Error).message;
    }
    return "";
  };

  test("LLM は me が付けた未決事項に --question で回答できず、何も書き込まない", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    const q = askQuestion(me, i.id, "対象はどれか").question;
    const before = getIssue(db, i.id);
    const events = eventsOf(db, i.id);
    expect(codeOf(() => answerQuestion(llm, i.id, "一覧", { questionId: q.id }))).toBe("FORBIDDEN_FOR_LLM");
    expect(messageOf(() => answerQuestion(llm, i.id, "一覧", { questionId: q.id }))).toBe(
      `LLM は me が付けた未決事項（質問 ${q.id}）に回答できません。回答は me に依頼してください`,
    );
    expect(getIssue(db, i.id)).toEqual(before);
    expect(eventsOf(db, i.id)).toEqual(events);
    expect(before.status).toBe("needs_clarification");
    expect(nextIssue(llm, { workspaceId: ws.id })).toBeNull();
    // 人は従来どおり回答でき、Todo に戻る
    expect(answerQuestion(me, i.id, "一覧", { questionId: q.id }).issue.status).toBe("todo");
  });

  test("me の未決事項は、回答済みでも LLM には FORBIDDEN_FOR_LLM を返し、回答を書き換えない", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    const q = askQuestion(me, i.id, "対象はどれか").question;
    answerQuestion(me, i.id, "一覧", { questionId: q.id });
    expect(codeOf(() => answerQuestion(llm, i.id, "詳細", { questionId: q.id }))).toBe("FORBIDDEN_FOR_LLM");
    expect(getIssue(db, i.id).questions).toEqual([expect.objectContaining({ answer: "一覧", answeredBy: "me" })]);
  });

  test("存在しない質問は LLM にも NOT_FOUND を返す", () => {
    const { ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b" });
    const qb = askQuestion(me, b.id, "b の質問").question;
    expect(codeOf(() => answerQuestion(llm, a.id, "x", { questionId: qb.id }))).toBe("NOT_FOUND");
  });

  test("LLM が付けた質問には、LLM が --question でもまとめてでも従来どおり回答できる", () => {
    const { db, ws, me, llm } = setup();
    const other = { db, actor: "codex" };
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    startIssue(llm, i.id);
    const q1 = askQuestion(llm, i.id, "一つ目").question;
    askQuestion(llm, i.id, "二つ目");
    expect(answerQuestion(other, i.id, "よい", { questionId: q1.id }).answered).toEqual([
      expect.objectContaining({ id: q1.id, answeredBy: "codex" }),
    ]);
    expect(answerQuestion(llm, i.id, "よい").issue.agentState).toBe("working");
  });

  test("LLM のまとめての回答は me の未決事項を閉じず、me の未決事項だけなら --question へ誘導しない", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    askQuestion(me, i.id, "私の未決事項");
    askQuestion(llm, i.id, "LLM の質問");
    expect(answerQuestion(llm, i.id, "よい").answered.map((q) => q.question)).toEqual(["LLM の質問"]);
    expect(getIssue(db, i.id)).toMatchObject({ status: "needs_clarification", openQuestions: [{ question: "私の未決事項" }] });
    expect(codeOf(() => answerQuestion(llm, i.id, "よい"))).toBe("NO_OPEN_QUESTION");
    const message = messageOf(() => answerQuestion(llm, i.id, "よい"));
    expect(message).toContain("未決事項（1 件）は me が決めます");
    expect(message).not.toContain("--question");
  });

  test("すでに LLM が回答した me の未決事項は、そのまま残る", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    const q = askQuestion(me, i.id, "対象はどれか").question;
    // ガードを入れる前に LLM が回答した行を再現する
    db.query("UPDATE questions SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ?").run("一覧", "claude-code", "2026-09-30T00:00:00.000Z", q.id);
    expect(getIssue(db, i.id).questions).toEqual([expect.objectContaining({ answer: "一覧", answeredBy: "claude-code" })]);
    expect(codeOf(() => answerQuestion(llm, i.id, "詳細", { questionId: q.id }))).toBe("FORBIDDEN_FOR_LLM");
    expect(codeOf(() => answerQuestion(me, i.id, "詳細", { questionId: q.id }))).toBe("NO_OPEN_QUESTION");
    expect(getIssue(db, i.id).questions).toEqual([expect.objectContaining({ answer: "一覧", answeredBy: "claude-code" })]);
  });
});

describe("getInbox", () => {
  test("私が足した未決事項は Inbox に出さない", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    startIssue(llm, i.id);
    askQuestion(me, i.id, "私の未決事項");
    askQuestion(llm, i.id, "LLM の質問");
    expect(getInbox(db).questions.map((q) => q.question)).toEqual(["LLM の質問"]);
  });
});

test("安全な整数を超える質問 ID は INVALID_ARGS で、回答を変更しない", () => {
  const { db, ws, me } = setup();
  const issue = createIssue(me, { workspaceId: ws.id, title: "質問 ID の検証" });
  askQuestion(me, issue.id, "対象は");
  const before = getIssue(db, issue.id);
  expect(codeOf(() => answerQuestion(me, issue.id, "回答", { questionId: Number.MAX_SAFE_INTEGER + 1 }))).toBe("INVALID_ARGS");
  expect(getIssue(db, issue.id)).toEqual(before);
});
