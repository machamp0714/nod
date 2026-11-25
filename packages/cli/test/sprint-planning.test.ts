import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createIssue, initWorkspace, openDb } from "@nod/core";
import * as core from "@nod/core";
import { prepareSprint } from "../../core/test/fixtures/sprint-start";
import { makeRepo, runNod, tempDb, tempDir } from "./helpers";

test("CLIでLLMが方向設定・合意・開始・中止でき、合意した書き手とhashを保持する", async () => {
  const cwd = makeRepo(), db = tempDb(), inputDir = tempDir();
  const d = openDb(db); const ws = initWorkspace(d,{path:cwd}).workspace;
  const issue = createIssue({db:d,actor:"me"},{workspaceId:ws.id,title:"判断を集める"}); d.close();
  let sequence = 0;
  const run = async (args:string[],input:unknown,actor="me") => {
    const file = join(inputDir,`${++sequence}.json`); writeFileSync(file,JSON.stringify(input));
    return runNod([...args,"--input",file,"--json"],{cwd,db,actor});
  };
  const config = {expectedVersion:0,requestKey:"設定",enabled:true,problem:"停滞",productGoal:"再開する",priorityRationale:"判断を優先"};
  expect((await run(["scrum","configure"],config,"codex")).exitCode).toBe(0);
  expect((await runNod(["scrum","show","--json"],{cwd,db,actor:"codex"})).json.version).toBe(1);
  const sprint = (await run(["sprint","create"],{workspaceKey:ws.key,startDate:"2000-01-01",endDate:"2999-01-01",timezone:"Asia/Tokyo",expectedVersion:0,requestKey:"作成"},"codex")).json;
  expect(sprint.phase).toBe("draft");
  const added = (await runNod(["sprint","add",sprint.id,issue.id,"--json"],{cwd,db,actor:"codex"})).json;
  const planInput = {goal:"回答後に再開",verificationMethod:"一巡する",items:[{itemId:added.item.id,contribution:"判断を集約",executionPlan:"Inboxへ追加"}],definitionOfDone:[{id:"操作",text:"再開を確認"}],constraints:{executionScope:"Workspace",notes:"公開は既存権限"},changeReason:"最初の計画"};
  const proposed = (await run(["sprint","plan","propose",sprint.id],{...planInput,expectedVersion:sprint.version,requestKey:"計画"},"codex")).json;
  const agree = {expectedVersion:proposed.sprint.version,requestKey:"合意",contentHash:proposed.plan.contentHash};
  expect((await run(["sprint","plan","accept",sprint.id,proposed.plan.id],{...agree,contentHash:"不一致"},"codex")).json.error.code).toBe("STALE_REVISION");
  const ready = (await run(["sprint","plan","accept",sprint.id,proposed.plan.id],agree,"codex")).json;
  expect(ready.plan).toMatchObject({agreedBy:"codex",agreedHash:proposed.plan.contentHash});
  const acceptedAgain = (await run(["sprint","plan","accept",sprint.id,proposed.plan.id],{...agree,expectedVersion:ready.sprint.version,requestKey:"再確認"},"claude-code")).json;
  expect(acceptedAgain).toEqual(ready);
  const changed = (await run(["sprint","plan","propose",sprint.id],{...planInput,goal:"別のゴール",expectedVersion:ready.sprint.version,requestKey:"変更"},"claude-code")).json;
  expect(changed.plan.agreedAt).toBeNull();
  expect((await run(["sprint","activate",sprint.id],{expectedVersion:changed.sprint.version,requestKey:"未合意開始"},"codex")).json.error.code).toBe("NOT_ACCEPTED");
  const reused = (await run(["sprint","plan","propose",sprint.id],{...planInput,expectedVersion:changed.sprint.version,requestKey:"同内容"},"claude-code")).json;
  expect(reused.plan).toMatchObject({agreedBy:"codex",agreedAt:ready.plan.agreedAt,agreedHash:ready.plan.contentHash});
  const activation = {expectedVersion:reused.sprint.version,requestKey:"開始"};
  const active = (await run(["sprint","activate",sprint.id],activation,"codex")).json;
  expect(active.phase).toBe("active");
  const shown = (await runNod(["sprint","show",sprint.id,"--json"],{cwd,db,actor:"me"})).json;
  expect(shown.activatedBy).toBe("codex");
  expect(shown.plans[0].contentHash).toBe(proposed.plan.contentHash);
  const text = (await runNod(["sprint", "show", sprint.id], { cwd, db })).stdout;
  expect(text).toContain(`開始: ${shown.activatedAt}（codex）`);
  expect(text).not.toContain("自動開始");
  expect((await run(["sprint","update",sprint.id],{expectedVersion:0,requestKey:"古い更新",name:"変更"})).json.error.code).toBe("STALE_REVISION");
  const cancel = {expectedVersion:active.version,requestKey:"中止",reason:"優先順位変更"};
  expect((await run(["sprint","cancel",sprint.id],cancel,"codex")).json.phase).toBe("canceled");
});

for (const matchingHash of [true, false]) test(`CLIの採択と開始はLLM合意のhash一致を要求する（一致=${matchingHash}）`, async () => {
  const cwd = makeRepo(), path = tempDb(), db = openDb(path), inputDir = tempDir();
  const ws = initWorkspace(db, { path: cwd }).workspace, ctx = { db, actor: "me" };
  const issue = createIssue(ctx, { workspaceId: ws.id, title: "旧候補の採択" });
  const prepared = prepareSprint(ctx, ws.key, [issue.id]);
  const period = core.updateSprint(ctx, prepared.sprint.id, { expectedVersion: prepared.sprint.version, requestKey: "期間", startDate: "2000-01-01", endDate: "2999-01-01" });
  const proposed = core.proposeSprintPlan(ctx, period.id, { ...prepared.input, expectedVersion: period.version, requestKey: "計画更新" });
  const ready = core.acceptSprintPlan({ db, actor: "codex" }, period.id, proposed.plan.id, { expectedVersion: proposed.sprint.version, requestKey: "合意", contentHash: proposed.plan.contentHash });
  core.setSprintRollover(ctx, ws.key, { enabled: false });
  // 旧候補のみの所属と、保存された合意hashが破損したデータを境界の入力として用意する。
  db.query("UPDATE sprint_items SET added_by=NULL,added_at=NULL WHERE sprint_id=?").run(period.id);
  if (!matchingHash) db.query("UPDATE sprint_plans SET agreed_hash='異なるhash' WHERE id=?").run(proposed.plan.id);
  db.close();
  const opts = { cwd, db: path, actor: "claude-code" };
  const shown = (await runNod(["sprint", "show", period.id, "--json"], opts)).json;
  expect(shown).toMatchObject({ activatedAt: null, activatedBy: null });
  expect((await runNod(["sprint", "show", period.id], opts)).stdout).not.toMatch(/^(?:自動)?開始:/m);
  expect(shown.items[0].member).toBe(matchingHash);
  const listed = (await runNod(["issue", "list", "--sprint", period.id, "--json"], opts)).json;
  expect(listed.map((i: { id: string }) => i.id)).toEqual(matchingHash ? [issue.id] : []);
  const input = join(inputDir, "activate.json");
  writeFileSync(input, JSON.stringify({ expectedVersion: ready.sprint.version, requestKey: "開始" }));
  const activation = await runNod(["sprint", "activate", period.id, "--input", input, "--json"], matchingHash ? { ...opts, actor: "me" } : opts);
  if (matchingHash) {
    expect(activation).toMatchObject({ exitCode: 0, json: { phase: "active" } });
    const shown = (await runNod(["sprint", "show", period.id, "--json"], opts)).json;
    expect(shown.activatedBy).toBe("me");
    const text = (await runNod(["sprint", "show", period.id], opts)).stdout;
    expect(text).toContain(`開始: ${shown.activatedAt}（me）`);
    expect(text).not.toContain("自動開始");
  } else expect(activation).toMatchObject({ exitCode: 1, json: { error: { code: "NOT_ACCEPTED" } } });
});

test("CLIはstdinのJSON入力を受け取り、不正JSONを日本語の構造化エラーで返す", async () => {
  const cwd=makeRepo(), db=tempDb();
  const d=openDb(db); initWorkspace(d,{path:cwd}); d.close();
  const send = async (body:string) => {
    const proc=Bun.spawn(["bun",join(import.meta.dir,"../src/main.ts"),"scrum","configure","--input","-","--json"],{
      cwd,env:{...process.env,NOD_DB:db,NOD_ACTOR:"me",NOD_ORCA:"0"},stdin:"pipe",stdout:"pipe",stderr:"pipe",
    });
    proc.stdin.write(body); proc.stdin.end();
    const [text,exit] = await Promise.all([new Response(proc.stdout).text(),proc.exited]);
    return {exit,json:JSON.parse(text)};
  };
  expect(await send(JSON.stringify({enabled:true,problem:"停滞",productGoal:"再開",priorityRationale:"判断を優先",expectedVersion:0,requestKey:"標準入力"}))).toMatchObject({exit:0,json:{version:1}});
  expect((await send("{" )).json.error.code).toBe("INVALID_ARGS");
});
