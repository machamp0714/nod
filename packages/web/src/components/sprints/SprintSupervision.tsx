import { useState } from "react";
import type { SprintDetail } from "../../api/types";
import { useSprintExecution } from "../../api/hooks/sprints";
import { errorMessage } from "../../api/errors";
import { Button } from "../ui";

const at = (value: string | null | undefined) => value ? <time dateTime={value}>{new Date(value).toLocaleString("ja-JP")}</time> : "未取得";
const value = (input: string | null | undefined) => input ?? "取得不能";
const phase = { reserved: "予約・起動前", awaiting_confirmation: "起動応答あり・設定確認待ち", unknown: "実行不明", start_authorized: "開始許可通知・実開始報告を確認", implementing: "実開始報告あり", completed: "担当終了確認・成果確認待ち" };
const operation = { task_create: "Task作成", worker_start: "担当起動", worker_begin: "開始許可通知" };
const resultKind = { observation: "ホスト観測", question: "相談", request_rejected: "要求の拒否", completion: "完了通知受理", notice: "通知" };
const ownership = { pending: "次所有者未確定", assigned: "次所有者を確定", sending: "解放要求を送信中", unknown: "解放結果不明", released: "正規解放確認済み" };

function CopyProcedure({ command }: { command: string }) {
  const [copying, setCopying] = useState(false), [message, setMessage] = useState("");
  const copy = async () => {
    if (copying) return;
    setCopying(true); setMessage("");
    try { await navigator.clipboard.writeText(command); setMessage("手順をコピーしました"); }
    catch { setMessage("コピーできませんでした。表示した手順を選択してコピーしてください。"); }
    finally { setCopying(false); }
  };
  return <><pre tabIndex={0} aria-label="実行できるCLI手順">{command}</pre><Button style={{ minHeight: 32 }} disabled={copying} onClick={() => void copy()}>{copying ? "コピー中…" : "手順をコピー"}</Button><span role="status">{message}</span></>;
}

export function SprintSupervision({ sprint }: { sprint: SprintDetail }) {
  const query = useSprintExecution(sprint.id, sprint.phase !== "imported");
  if (sprint.phase === "imported") return <p>移行履歴です。現在の監督・実行の記録とは区別して確認してください。</p>;
  const retry = <Button style={{ minHeight: 32 }} disabled={query.isFetching} onClick={() => void query.refetch()}>{query.isFetching ? "取得中…" : "保存状態を再取得"}</Button>;
  if (!query.data) return <section aria-label="監督と実行"><p role={query.error ? "alert" : "status"}>{query.error ? `監督と実行の記録を取得できません。${errorMessage(query.error)}。0件とは判定できません。` : "監督と実行の保存記録を読み込み中…"}</p>{retry}</section>;
  const saved = query.data, state = saved.execution, session = state.session;
  return <section aria-label="監督と実行">
    {query.error && <p role="alert">保存状態の再取得に失敗しました。{errorMessage(query.error)}。最後に取得した状態を表示しています。保存状態の取得時刻：{at(state.observedAt)}</p>}
    <p>現在の監督：{session ? `${session.actor}（${session.state === "handover" ? "引継ぎ待ち・新規許可停止" : "監督を所有"}、世代${session.generation}）` : "記録なし。実際のPM・workerの存在は未確認です。"}</p>
    <p>最終観測：{at(session?.observedAt)} / {session?.source ?? "観測元なし"}{session && state.stale ? "。観測が古いため、現在の監督状態は不明です。所有と枠を保持しています。" : session ? "（取得時点の記録）" : ""}</p>
    <p>占有 {state.occupied} / 上限 {state.maxParallel ?? "未確認"}（主試行の予約 {state.reserved}、通常所有の未照合 {state.unreconciledOwnership.length}、補助担当 {state.attempts.filter(a => a.parentAttemptId).length}）</p>
    <p>実装開始：{state.canStart ? "許可あり。実開始報告は別に確認してください。" : "許可なし。各担当の理由と着手条件を確認してください。"}</p>
    {state.attempts.length === 0 && <p>担当の試行記録はありません。実際に担当がいないという証明ではありません。</p>}
    {state.attempts.map(a => <p key={a.id}>{a.sourceIssueKey} / {a.parentAttemptId ? "補助担当" : "主担当"} {a.actor} / 工程：{phase[a.phase]} / {a.reason.code}：{a.reason.message}{a.executionLiveness?.verdict === "unverifiable" ? "。実行を確認できません。所有と枠を保持しています。" : ""}</p>)}
    {state.unreconciledOwnership.map(a => <p key={a.itemId}>{a.sourceIssueKey} / 元担当：{a.assignee ?? "未確認"} / {a.reason.code}：{a.reason.message}</p>)}
    <p>通知：受理結果 {saved.results.length}、競合 {saved.conflicts.length}、隔離 {saved.quarantined.length + state.quarantined.length}、ack未確定 {saved.deliveries.filter(d => !d.acknowledged).length}</p>
    {saved.results.filter(r => r.completion).map(r => <p key={r.id}>完了通知受理：{r.completion!.outcome === "succeeded" ? "担当の成功報告" : "担当の失敗報告"} / {r.completion!.state === "settled" ? "正規の終了確認あり" : "終了の照合不明"} / {ownership[r.completion!.ownership.state]} / 物理解放：{r.completion!.releaseOperation?.state === "unknown" ? "結果不明" : r.completion!.ownership.receipt?.state ?? "未確認"}。成果の検証とIssue完了・ゴール達成は別に確認してください。</p>)}
    <p>次の行動：{session ? "現在の監督と元の担当を、保存した再照合手順で確認する。" : "計画を確認し、元Run・現在の監督と既存担当を確かめて監督記録を登録する。"}{sprint.phase === "canceled" ? " 中止理由と未解決の所有を確認してください。" : sprint.phase === "ended" ? " 期間終了後の残件と未解決の所有を確認してください。" : ""}</p>
    <p>保存状態の取得時刻：{at(state.observedAt)}。再取得は保存記録を読む操作です。Orca実状態の再照合はCLI手順を実行してください。{retry}</p>
    <details><summary>実行の詳細・再照合手順</summary>
      <p>元RunのあるOrca接続先と、同じnod DBを使う端末で実行してください。保存した監督のactorをNOD_ACTORへ一回だけ指定しています。接続先が別hostなら、そのRun homeへ接続してから実行してください。</p>
      {session && <p>監督端末：{session.caller} / actor：{session.actor} / session：{session.id} / Run：{session.runId} / runtime：{session.runtimeId} / consumer世代：{session.consumerGeneration}</p>}
      {!session && <p>監督のsession・世代・Run・actorが未登録のため、実行値を埋めた再照合命令はまだ作れません。既存の計画と元Runを確認してください。</p>}
      {state.nextActions.map((action, i) => <div key={i}><p>{action.description}</p><CopyProcedure command={action.command} /></div>)}
      {state.attempts.map(a => {
        const receipt = state.operations.find(o => o.attemptId === a.id && o.kind === "worker_start")?.receipt;
        const host = a.hostObservation, requested = a.settingsRequirement;
        const plan = sprint.plans.find(p => p.id === a.planId);
        return <details key={a.id}><summary>{a.sourceIssueKey} {a.parentAttemptId ? "補助担当" : "主担当"} {a.actor}の根拠</summary>
          <p>試行：{a.id} / Task：{a.taskId ?? "未取得"} / Dispatch：{a.dispatchId ?? "未取得"} / 工程：{phase[a.phase]}</p>
          <p>実行観測：{a.executionLiveness?.verdict ?? "未取得"} / {at(a.executionLiveness?.observedAt)} / {a.executionLiveness?.source ?? "取得元未記録"}</p>
          <p>実行場所の要求：{a.placement.on ?? "Run home"} / {a.placement.worktree}</p>
          <p>要求した設定：{requested?.agent ?? a.placement.agent} / model：{requested?.model ?? "明示値なし・継承条件を確認"} / effort：{requested?.effort ?? "明示値なし・継承条件を確認"} / 配置：{requested?.target ?? "明示値なし"}</p>
          <p>取得元：合意済み計画 {a.planId} / hash：{a.planHash} / 合意日時：{at(plan?.agreedAt)}。起動への指定：{value(a.placement.model)} / {value(a.placement.effort)}。</p>
          {requested?.policy && <p>継承の許可範囲：model {requested.policy.allowedModels.join(", ")} / effort {requested.policy.allowedEfforts.join(", ")} / 配置 {requested.policy.allowedTargets.join(", ")}</p>}
          <p>起動receiptのrequested：{value(receipt?.requested?.agent)} / {value(receipt?.requested?.model)} / {value(receipt?.requested?.effort)}</p>
          <p>起動receiptのeffective：{value(receipt?.effective?.agent)} / {value(receipt?.effective?.model)} / {value(receipt?.effective?.effort)} / 取得元：{receipt?.source ?? "未取得"} / 受信日時：{at(receipt?.receivedAt)}</p>
          <p>ホスト観測の設定：model {value(host?.metadata.model)} / effort {value(host?.metadata.effort)} / provider {value(host?.metadata.provider)} / 取得元：{host?.metadata.source ?? "未取得"}</p>
          <p>設定適用日時：{at(host?.metadata.settingsAppliedAt)} / 採取日時：{at(host?.metadata.collectedAt)} / Orca観測日時：{at(host?.independent?.observedAt)} / PM照合日時：{at(host?.verifiedAt)}</p>
          <p>ホスト照合：{host?.result ?? "取得不能"} / {host?.reason ? `${host.reason.code}：${host.reason.message}` : host ? "取得時点の対応を確認" : "要求値やreceiptで欠測を補いません"}</p>
          <p>実ホストの配置：{host?.independent?.cwd ?? "取得不能"} / {host?.independent?.source ?? "未取得"} / runtime {value(host?.independent?.identity.runtimeId)} / incarnation {value(host?.independent?.identity.incarnationId)}</p>
          <p>provider thread：{value(host?.metadata.threadId)} / turn：{value(host?.metadata.turnId)} / 自己host観測：{at(host?.selfHost.observedAt)}</p>
          <p>開始確認：{at(a.startConfirmation?.createdAt)} / 開始許可：{at(a.startAuthorization?.authorizedAt)} / 実開始報告：{at(a.startedReport?.reportedAt)} / 開始報告照合：{at(a.startedReport?.verifiedAt)}</p>
          {a.observationHistory && <details><summary>過去のホスト観測（{a.observationHistory.length}件）</summary>{a.observationHistory.map((h, i) => <p key={i}>{h.result} / model {value(h.metadata.model)} / effort {value(h.metadata.effort)} / 設定適用 {at(h.metadata.settingsAppliedAt)} / 採取 {at(h.metadata.collectedAt)} / PM照合 {at(h.verifiedAt)} / {h.reason?.message}</p>)}</details>}
        </details>;
      })}
      <details><summary>外部操作・受理と配送の根拠</summary>
        {state.operations.map(o => <p key={o.id}>{operation[o.kind]}：{o.state} / operation：{o.id} / request：{o.requestId ?? "未取得"} / {o.reason?.code} {o.reason?.message}</p>)}
        {saved.results.map(r => <p key={r.id}>{resultKind[r.kind]} / 結果：{r.id} / 保存：{at(r.savedAt)}{r.completion && <> / 終了照合：{r.completion.state} / 次所有者：{r.completion.nextOwner ?? "未確定"} / {ownership[r.completion.ownership.state]} / 実解放receipt：{r.completion.ownership.receipt?.state ?? "未取得"}（{at(r.completion.ownership.receipt?.observedAt)} / {r.completion.ownership.receipt?.reason ?? "理由なし"}） / 解放operation：{r.completion.releaseOperation?.state ?? "記録なし"} / 解放request：{r.completion.releaseOperation?.requestId ?? "未取得"} / 元request照合：{r.completion.releaseOperation?.reconciliation?.state ?? "未取得"}</>}</p>)}
        {saved.deliveries.map(d => <div key={d.deliveryId}><p>Delivery：{d.deliveryId} / ack：{d.acknowledged ? "確認済み" : "未確定"} / {d.reason?.code} {d.reason?.message}</p>{d.rows.filter(r => r.reason).map((r, i) => <p key={i}>{r.reason!.code}：{r.reason!.message}</p>)}</div>)}
        {saved.conflicts.map((r, i) => <p key={`c${i}`}>競合：{r.reason.code} {r.reason.message} / {at(r.savedAt)}</p>)}
        {saved.quarantined.map((r, i) => <p key={`q${i}`}>隔離：{r.reason.code} {r.reason.message} / {at(r.observedAt)}</p>)}
        {state.quarantined.map((r, i) => <p key={`e${i}`}>隔離した操作：{r.operationId} / 世代 {r.generation} / {r.reason}</p>)}
      </details>
    </details>
  </section>;
}
