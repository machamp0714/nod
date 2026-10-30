import { expect, spyOn, test } from "bun:test";
import { clearCadence, getCadence, setCadence, syncCycles } from "../src/ops/cycle-cadence";
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

test('旧通常起動からの同期を何度呼んでも期間を作らず、未完了Issueを持ち越さず、transactionも開かない',()=>{
  const {db,ws,me}=setup();
  const issue=createIssue(me,{workspaceId:ws.id,title:'未完了Issue'});
  const before=getIssue(db,issue.id);
  const changes=db.query('SELECT total_changes() AS n').get();
  const transaction=spyOn(db,'transaction');
  try {
    for (const today of ['2026-01-01','2026-10-26','2027-01-01']) expect(syncCycles(me,{today})).toEqual({created:[],carried:[]});
    expect(transaction).not.toHaveBeenCalled();
  } finally {transaction.mockRestore();}
  expect(db.query('SELECT total_changes() AS n').get()).toEqual(changes);
  expect(getIssue(db,issue.id)).toEqual(before);
  expect(db.query('SELECT * FROM sprints').all()).toEqual([]);
  db.close();
});
