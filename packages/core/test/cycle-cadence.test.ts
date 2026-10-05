import { describe, expect, spyOn, test } from "bun:test";
import { clearCadence, getCadence, setCadence, syncCycles } from "../src/ops/cycle-cadence";
import { createCycle, deleteCycle, listCycles } from "../src/ops/cycles";
import { archiveIssue, createIssue, getIssue, updateIssue } from "../src/ops/issues";
import { initWorkspace } from "../src/ops/workspaces";
import { codeOf, eventsOf, setup } from "./helpers";

const at = (today: string) => ({ today });
const names = (db: Parameters<typeof listCycles>[0], today: string) => listCycles(db, at(today)).map((c) => `${c.name} ${c.startDate}〜${c.endDate} ${c.state}`);

describe("周期の設定", () => {
  test("weeks は 1〜4、開始日は日付。設定・解除は人だけ", () => {
    const { db, me, llm } = setup();
    expect(codeOf(() => setCadence(me, { weeks: 0, anchorDate: "2026-10-05" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => setCadence(me, { weeks: 5, anchorDate: "2026-10-05" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => setCadence(me, { weeks: 2, anchorDate: "2026-02-30" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => setCadence(llm, { weeks: 2, anchorDate: "2026-10-05" }))).toBe("FORBIDDEN_FOR_LLM");
    expect(setCadence(me, { weeks: 2, anchorDate: "2026-10-05" }, at("2026-10-05"))).toMatchObject({ weeks: 2, autoCarryOver: true, anchorDate: "2026-10-05" });
    expect(codeOf(() => clearCadence(llm))).toBe("FORBIDDEN_FOR_LLM");
    clearCadence(me);
    expect(getCadence(db)).toBeNull();
  });

  test("最初の Cycle の終了日が 9999-12-31 を超える開始日は受け付けない", () => {
    const { me } = setup();
    expect(codeOf(() => setCadence(me, { weeks: 2, anchorDate: "9999-12-25" }))).toBe("INVALID_ARGS");
    expect(setCadence(me, { weeks: 1, anchorDate: "9999-12-25" }, at("2026-10-05")).anchorDate).toBe("9999-12-25");
  });
});

describe("syncCycles: 自動作成", () => {
  test("周期がなければ何もしない", () => {
    const { db, me } = setup();
    expect(syncCycles(me, at("2026-10-05"))).toEqual({ created: [], carried: [] });
    expect(listCycles(db)).toEqual([]);
  });

  test("Cycle がなく開始日が過去なら、今日を含む区間と次を作る。2回呼んでも同じ", () => {
    const { db, me } = setup();
    setCadence(me, { weeks: 2, anchorDate: "2026-09-07" }, at("2026-10-05"));
    syncCycles(me, at("2026-10-05"));
    syncCycles(me, at("2026-10-05"));
    expect(names(db, "2026-10-05")).toEqual(["Cycle 1 2026-10-05〜2026-10-18 current", "Cycle 2 2026-10-19〜2026-11-01 upcoming"]);
  });

  test("開始日が未来なら、その日から始まる Cycle を1つだけ作る", () => {
    const { db, me } = setup();
    setCadence(me, { weeks: 1, anchorDate: "2026-10-12" }, at("2026-10-05"));
    syncCycles(me, at("2026-10-05"));
    expect(names(db, "2026-10-05")).toEqual(["Cycle 1 2026-10-12〜2026-10-18 upcoming"]);
  });

  test("current が最後なら次を足す。数週間あいたら間を作らず今日を含む区間と次だけを作る", () => {
    const { db, me } = setup();
    setCadence(me, { weeks: 2, anchorDate: "2026-10-05" }, at("2026-10-05"));
    syncCycles(me, at("2026-10-05"));
    syncCycles(me, at("2026-10-19"));
    expect(names(db, "2026-10-19").map((n) => n.split(" ")[1])).toEqual(["1", "2", "3"]);
    syncCycles(me, at("2026-12-10")); // Cycle 3 は 11-02〜11-15。12-10 を含む区間は 11-30〜12-13
    expect(names(db, "2026-12-10").slice(-2)).toEqual(["Cycle 4 2026-11-30〜2026-12-13 current", "Cycle 5 2026-12-14〜2026-12-27 upcoming"]);
  });

  test("月末・年末・うるう日をまたいでも L 日で区切る", () => {
    const { db, me } = setup();
    setCadence(me, { weeks: 1, anchorDate: "2027-12-27" }, at("2027-12-27"));
    syncCycles(me, at("2028-02-28"));
    expect(names(db, "2028-02-28")).toEqual(["Cycle 1 2028-02-28〜2028-03-05 current", "Cycle 2 2028-03-06〜2028-03-12 upcoming"]);
  });

  test("手動の Cycle の続きから作り、名前が重なれば番号を進める", () => {
    const { db, me } = setup();
    createCycle(me, { name: "Cycle 1", startDate: "2026-09-28", endDate: "2026-10-04" }, at("2026-10-05"));
    setCadence(me, { weeks: 1, anchorDate: "2026-01-01" }, at("2026-10-05"));
    syncCycles(me, at("2026-10-05"));
    expect(names(db, "2026-10-05")).toEqual([
      "Cycle 1 2026-09-28〜2026-10-04 completed",
      "Cycle 2 2026-10-05〜2026-10-11 current",
      "Cycle 3 2026-10-12〜2026-10-18 upcoming",
    ]);
    expect(getCadence(db)!.nextNumber).toBe(4);
  });

  test("weeks の変更は次に作る Cycle から", () => {
    const { db, me } = setup();
    setCadence(me, { weeks: 1, anchorDate: "2026-10-05" }, at("2026-10-05"));
    syncCycles(me, at("2026-10-05"));
    setCadence(me, { weeks: 2 }, at("2026-10-05"));
    syncCycles(me, at("2026-10-12"));
    expect(names(db, "2026-10-12")).toEqual([
      "Cycle 1 2026-10-05〜2026-10-11 completed",
      "Cycle 2 2026-10-12〜2026-10-18 current",
      "Cycle 3 2026-10-19〜2026-11-01 upcoming",
    ]);
  });

  test("今日は tz の暦日で決める", () => {
    const { db, me } = setup();
    setCadence(me, { weeks: 1, anchorDate: "2026-10-05" }, at("2026-10-04"));
    const now = new Date("2026-10-11T20:00:00Z"); // 東京は 10-12、ロサンゼルスは 10-11
    syncCycles(me, { tz: "America/Los_Angeles", now });
    expect(listCycles(db)).toHaveLength(2);
    syncCycles(me, { tz: "Asia/Tokyo", now });
    expect(listCycles(db)).toHaveLength(3);
  });

  test("やることがなければトランザクションを開かない", () => {
    const { db, me } = setup();
    setCadence(me, { weeks: 1, anchorDate: "2026-10-05" }, at("2026-10-05"));
    syncCycles(me, at("2026-10-05"));
    const spy = spyOn(db, "transaction"); // tx() は db.transaction(...).immediate() で書き込みのロックを取る
    expect(syncCycles(me, at("2026-10-05"))).toEqual({ created: [], carried: [] });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test("終了日が 9999-12-31 を超える Cycle は作らず、以後の呼び出しも何もしない", () => {
    const { db, me } = setup();
    createCycle(me, { name: "長期", startDate: "2026-10-01", endDate: "9999-12-25" }, at("2026-10-05"));
    setCadence(me, { weeks: 1 }, at("2026-10-05"));
    expect(syncCycles(me, at("2026-10-05"))).toEqual({ created: [], carried: [] });
    expect(names(db, "2026-10-05")).toEqual(["長期 2026-10-01〜9999-12-25 current"]);
    const spy = spyOn(db, "transaction");
    expect(syncCycles(me, at("2026-10-05"))).toEqual({ created: [], carried: [] });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test("最後の Cycle が 9999-12-31 に終わっていても例外にしない", () => {
    const { db, me } = setup();
    createCycle(me, { name: "最後", startDate: "9999-12-01", endDate: "9999-12-31" }, at("9999-12-31"));
    setCadence(me, { weeks: 1 }, at("9999-12-31"));
    expect(syncCycles(me, at("9999-12-31"))).toEqual({ created: [], carried: [] });
    expect(listCycles(db)).toHaveLength(1);
  });

  test("最大の ID の Cycle を消すと作り直すが、ID は使い回さない", () => {
    const { db, me } = setup();
    setCadence(me, { weeks: 2, anchorDate: "2026-10-05" }, at("2026-10-05"));
    syncCycles(me, at("2026-10-05"));
    const last = listCycles(db, at("2026-10-05")).at(-1)!;
    deleteCycle(me, String(last.id), at("2026-10-05"));
    const [recreated] = syncCycles(me, at("2026-10-05")).created;
    expect(recreated).toMatchObject({ startDate: last.startDate });
    expect(recreated!.id).toBeGreaterThan(last.id);
  });
});

describe("syncCycles: 自動持ち越し", () => {
  function started(today = "2026-10-05") {
    const s = setup();
    setCadence(s.me, { weeks: 1, anchorDate: "2026-10-05" }, at(today));
    syncCycles(s.me, at(today));
    return s;
  }

  test("終了日当日は移さず、翌日に未完了だけを一度だけ今日の Cycle へ移す", () => {
    const { db, ws, me } = started();
    const open = createIssue(me, { workspaceId: ws.id, title: "未完了", cycleRef: "Cycle 1" });
    const done = createIssue(me, { workspaceId: ws.id, title: "完了", cycleRef: "Cycle 1" });
    updateIssue(me, done.id, { status: "done" });
    const canceled = createIssue(me, { workspaceId: ws.id, title: "中止", cycleRef: "Cycle 1" });
    updateIssue(me, canceled.id, { status: "canceled" });
    const archived = createIssue(me, { workspaceId: ws.id, title: "アーカイブ", cycleRef: "Cycle 1" });
    archiveIssue(me, archived.id);
    expect(syncCycles(me, at("2026-10-11")).carried).toEqual([]);
    const result = syncCycles(me, at("2026-10-12"));
    expect(result.carried.map((r) => r.moved)).toEqual([[open.id]]);
    expect(getIssue(db, open.id).cycle?.name).toBe("Cycle 2");
    expect(eventsOf(db, open.id).at(-1)!.data.automation).toBe("cycle-carry-over");
    updateIssue(me, open.id, { cycleRef: "Cycle 1" }); // 人が戻しても
    syncCycles(me, at("2026-10-13"));
    expect(getIssue(db, open.id).cycle?.name).toBe("Cycle 1"); // 再び移さない
  });

  test("OFF なら移さない。ON に戻しても過去の分は移さない", () => {
    const { db, ws, me } = started();
    setCadence(me, { weeks: 1, autoCarryOver: false }, at("2026-10-05"));
    const open = createIssue(me, { workspaceId: ws.id, title: "未完了", cycleRef: "Cycle 1" });
    syncCycles(me, at("2026-10-12"));
    expect(getIssue(db, open.id).cycle?.name).toBe("Cycle 1");
    setCadence(me, { weeks: 1, autoCarryOver: true }, at("2026-10-12"));
    syncCycles(me, at("2026-10-12"));
    expect(getIssue(db, open.id).cycle?.name).toBe("Cycle 1");
  });

  test("周期を設定した時点で終わっていた Cycle の Issue は移さない", () => {
    const { db, ws, me } = setup();
    createCycle(me, { name: "旧", startDate: "2026-09-28", endDate: "2026-10-04" }, at("2026-10-05"));
    const open = createIssue(me, { workspaceId: ws.id, title: "未完了", cycleRef: "旧" });
    setCadence(me, { weeks: 1, anchorDate: "2026-10-05" }, at("2026-10-05"));
    syncCycles(me, at("2026-10-05"));
    expect(getIssue(db, open.id).cycle?.name).toBe("旧");
  });

  test("周期を外すと自動作成も持ち越しも止まり、外している間に終わった Cycle は再設定しても移さない", () => {
    const { db, ws, me } = started();
    const open = createIssue(me, { workspaceId: ws.id, title: "未完了", cycleRef: "Cycle 1" });
    clearCadence(me);
    expect(syncCycles(me, at("2026-10-30"))).toEqual({ created: [], carried: [] });
    expect(listCycles(db)).toHaveLength(2);
    setCadence(me, { weeks: 1 }, at("2026-10-30")); // 再設定時点で終わっている Cycle は印を埋める
    syncCycles(me, at("2026-10-30"));
    expect(getIssue(db, open.id).cycle?.name).toBe("Cycle 1");
  });

  test("次の Cycle を手で消していても、今日の Cycle を作り直してから持ち越す", () => {
    const { db, ws, me } = started();
    const open = createIssue(me, { workspaceId: ws.id, title: "未完了", cycleRef: "Cycle 1" });
    db.query("DELETE FROM cycles WHERE name = 'Cycle 2'").run();
    syncCycles(me, at("2026-10-12")); // Cycle 1 の後ろに 10-12 を含む区間（Cycle 3）と次（Cycle 4）を作る
    expect(names(db, "2026-10-12").map((n) => n.split(" ").slice(0, 2).join(" "))).toEqual(["Cycle 1", "Cycle 3", "Cycle 4"]);
    expect(getIssue(db, open.id).cycle?.name).toBe("Cycle 3");
  });

  test("Workspace をまたいで持ち越す", () => {
    const { db, ws, me } = started();
    const other = initWorkspace(db, { path: "/tmp/repos/web" }).workspace;
    const a = createIssue(me, { workspaceId: ws.id, title: "a", cycleRef: "Cycle 1" });
    const b = createIssue(me, { workspaceId: other.id, title: "b", cycleRef: "Cycle 1" });
    syncCycles(me, at("2026-10-12"));
    expect([getIssue(db, a.id).cycle?.name, getIssue(db, b.id).cycle?.name]).toEqual(["Cycle 2", "Cycle 2"]);
  });
});
