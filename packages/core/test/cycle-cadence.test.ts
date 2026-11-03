import { expect, test } from "bun:test";
import { clearCadence, getCadence, setCadence } from "../src/ops/cycle-cadence";
import { createIssue, getIssue } from "../src/ops/issues";
import { codeOf, setup } from "./helpers";

test('旧周期の取得と設定と解除はactorによらず廃止案内を返し、保存データを変えない',()=>{
  const {db,ws,me,llm}=setup();
  const issue=createIssue(me,{workspaceId:ws.id,title:'通常Issue'});
  const before=getIssue(db,issue.id);
  const changes=db.query('SELECT total_changes() AS n').get();
  for (const ctx of [me,llm]) {
    expect(codeOf(()=>setCadence(ctx,{weeks:2,autoCarryOver:true,anchorDate:'2026-10-01'}))).toBe('CYCLE_RETIRED');
    expect(codeOf(()=>clearCadence(ctx))).toBe('CYCLE_RETIRED');
  }
  expect(codeOf(()=>getCadence(db))).toBe('CYCLE_RETIRED');
  expect(db.query('SELECT total_changes() AS n').get()).toEqual(changes);
  expect(getIssue(db,issue.id)).toEqual(before);
  db.close();
});
// 旧周期の同期（syncCycles）は、期限到来時のSprint自動引継ぎ（sprint-rollover.test.ts）に置き換えて取り除いた。
