import type { ActivityItem } from "./types";

// Activity の event を人が読む文にする（#198）。Web と CLI で同じ文を使うため、DB に依存しない関数にしてある。
// text は「誰が何をしたか」の文、detail は event の data に残る補足（起票元、自動化のルールなど）。
// Web は text だけを出し、CLI は text の後ろに detail を（）で添える。

export interface ActivityLabels {
  status: (value: unknown) => string;
  priority: (value: unknown) => string;
  agentState: (value: unknown) => string;
}

export interface EventText {
  text: string;
  detail: string[];
}

type ActivityEvent = Extract<ActivityItem, { kind: "event" }>;

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function orNone(value: unknown): string {
  return value === null || value === undefined || value === "" ? "なし" : String(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function withReason(sentence: string, data: Record<string, unknown>): string {
  const reason = text(data.reason);
  return reason ? `${sentence}：${reason}` : sentence;
}

function automationOf(data: Record<string, unknown>): string[] {
  const automation = text(data.automation);
  return automation ? [`自動化: ${automation}`] : [];
}

function fromTo(data: Record<string, unknown>): string[] {
  return [`${orNone(data.from)} → ${orNone(data.to)}`];
}

// 知らない種類は null を返す（呼び出し側が種類の名前や data をそのまま出す）
export function describeEvent(item: ActivityEvent, labels: ActivityLabels): EventText | null {
  const { actor, data } = item;
  const line = (sentence: string, detail: string[] = []): EventText => ({ text: sentence, detail });
  switch (item.type) {
    case "created": {
      const detail = data.status === undefined ? [] : [`状態: ${labels.status(data.status)}`];
      const source = text(data.discovered_from);
      if (source) detail.push(`起票元: ${source}`);
      const imported = text(data.imported_from);
      if (imported) detail.push(`取り込み元: ${imported}`);
      const copied = text(data.copied_from);
      if (copied) return line(`${actor} が ${copied} から複製した`, detail);
      // 定期Issue（#32）の実行で起票したもの。定義を消しても ID と発生日は event に残る
      if (typeof data.recurring_id === "number" && typeof data.occurrence === "string") {
        return line(`${actor} が定期Issue #${data.recurring_id}（${data.occurrence} 分）から起票した`, detail);
      }
      return line(`${actor} が起票した`, detail);
    }
    case "archived":
      return line(withReason(`${actor} がアーカイブした`, data), automationOf(data));
    case "unarchived":
      return line(`${actor} がアーカイブから復元した`);
    case "pr_linked": {
      const before = text(data.from);
      return line(`${actor} が PR を紐付けた：${String(data.to ?? "")}`, before ? [`以前: ${before}`] : []);
    }
    case "status_changed": {
      const detail = automationOf(data);
      if (typeof data.report_comment_id === "number") detail.push(`報告: #${data.report_comment_id}`);
      return line(withReason(`${actor} がステータスを ${labels.status(data.from)} から ${labels.status(data.to)} に変えた`, data), detail);
    }
    case "priority_changed":
      return line(`${actor} が優先度を ${labels.priority(data.from)} から ${labels.priority(data.to)} に変えた`);
    case "estimate_changed": {
      const estimate = (value: unknown) => (typeof value === "number" ? `${value} pt` : "なし");
      return line(`${actor} が見積もりを ${estimate(data.from)} から ${estimate(data.to)} に変えた`);
    }
    case "due_date_changed":
      // 年をまたいでも読めるよう、期限は YYYY-MM-DD のまま出す
      return line(`${actor} が期限を ${text(data.from) ?? "なし"} から ${text(data.to) ?? "なし"} に変えた`);
    case "assignee_changed":
      return line(`${actor} が担当者を ${text(data.from) ?? "なし"} から ${text(data.to) ?? "なし"} に変えた`);
    case "title_changed":
      return line(`${actor} がタイトルを変えた`, typeof data.from === "string" && typeof data.to === "string" ? [`「${data.from}」→「${data.to}」`] : []);
    case "description_changed":
      // 説明の全文は出さない（今の説明は Issue の本体にある）
      return line(`${actor} が説明を変えた`);
    case "project_changed":
      return line(`${actor} が Project を変えた`, fromTo(data));
    case "milestone_changed":
      return line(`${actor} が Milestone を ${typeof data.from === "string" ? data.from : "なし"} から ${typeof data.to === "string" ? data.to : "なし"} に変えた`);
    case "cycle_changed":
      return line(data.to == null ? `${actor} が Cycle から外した` : `${actor} が Cycle を ${String(data.to)} に変えた`, [...(data.from == null ? [] : [`以前: ${String(data.from)}`]), ...automationOf(data)]);
    case "parent_changed":
      return line(`${actor} が親 Issue を変えた`, fromTo(data));
    case "labels_changed": {
      const parts = [...strings(data.added).map((l) => `+${l}`), ...strings(data.removed).map((l) => `−${l}`)];
      return line(`${actor} がラベルを変えた（${parts.join(" ")}）`);
    }
    case "agent_state_changed": {
      const agent = text(data.agent);
      if (data.to === null) return line(agent ? `${actor} が ${agent} の作業状況を解除した` : `${actor} が作業状況を解除した`);
      const state = labels.agentState(data.to);
      // 入力待ちの理由は質問文で、同じ質問の行と重なるので出さない
      const reason = data.to === "awaiting_input" ? null : text(data.reason);
      const detail = reason ? [`理由: ${reason}`] : [];
      if (data.trigger === "answer") {
        return line(agent ? `${actor} の回答で ${agent} の作業状況が ${state} になった` : `${actor} の回答で作業状況が ${state} になった`, detail);
      }
      if (agent) return line(agent === actor ? `${agent} の作業状況が ${state} になった` : `${actor} が ${agent} の作業状況を ${state} に変えた`, detail);
      return line(`${actor} が作業状況を ${state} に変えた`, detail);
    }
    case "plan_updated": {
      if (data.ref !== undefined) return line(`${actor} が計画を更新した`, [`${String(data.ref)} → ${String(data.status)}`]);
      const source = text(data.source);
      return line(`${actor} が計画を更新した`, [...(source ? [`取り込み: ${source}`] : []), ...(typeof data.tasks === "number" ? [`${data.tasks} Task`] : [])]);
    }
    case "document_attached":
      return line(`${actor} が Document を添付した`, data.document_id === undefined ? [] : [`Document ${String(data.document_id)}`]);
    case "document_detached":
      return line(`${actor} が Document を外した`, data.document_id === undefined ? [] : [`Document ${String(data.document_id)}`]);
    case "attachment_added": {
      const source = text(data.source_path);
      return line(`${actor} が${data.kind === "file" ? "ファイル" : "リンク"}を添付した：${String(data.name ?? "")}`, source ? [`元: ${source}`] : []);
    }
    case "attachment_removed":
      return line(`${actor} が添付を削除した：${String(data.name ?? "")}`);
    case "relation_added":
      return line(`${actor} が関連 Issue を足した：${String(data.type)} ${String(data.to)}`);
    case "triage_accepted":
      return line(withReason(`${actor} が受け入れた`, data));
    case "triage_declined":
      return line(withReason(`${actor} が却下した`, data));
    case "review_approved":
      return line(withReason(`${actor} が承認した`, data));
    case "review_rejected": {
      const delegate = text(data.delegate);
      return line(withReason(`${actor} が差し戻した`, data), delegate ? [`対応依頼: ${delegate}`] : []);
    }
    case "comment_thread_resolved":
      return line(`${actor} がコメントのスレッドを解決済みにした`, data.comment_id === undefined ? [] : [`#${String(data.comment_id)}`]);
    case "comment_thread_reopened":
      return line(`${actor} がコメントのスレッドを未解決に戻した`, data.comment_id === undefined ? [] : [`#${String(data.comment_id)}`]);
    default:
      return null;
  }
}
