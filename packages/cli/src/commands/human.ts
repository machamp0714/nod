import { parsePositiveInt } from "../args";
import {
  acceptTriage,
  answerQuestion,
  approveReview,
  declineTriage,
  deleteNotifications,
  duplicateTriage,
  getInbox,
  listNotifications,
  markNotificationsRead,
  NodError,
  rejectReview,
  restoreNotifications,
  snoozeNotifications,
  snoozeTriage,
  suggestTriage,
  unsnoozeNotifications,
} from "@nod/core";
import type { Command } from "commander";
import { act } from "../context";
import { formatIssueLine, formatNotification, formatTriageSuggestions, print, statusColumnWidth } from "../output";

// 通知を操作する対象。id（nod notification list の #番号）か --issue
function notificationTarget(ids: string[], issue: string | undefined): { ids?: number[]; issueRef?: string } {
  return { ids: ids.length ? ids.map((id) => parsePositiveInt(id, "通知の id")) : undefined, issueRef: issue };
}

export function registerHumanCommands(program: Command): void {
  program
    .command("inbox")
    .description("全 Workspace の LLM からの確認依頼とレビュー待ち、購読中の Issue と LLM に任せた Issue の未読の通知を一覧する")
    .action(
      act((cli) => {
        const inbox = { ...getInbox(cli.db), notifications: listNotifications(cli.db) };
        print(cli, inbox, () =>
          [
            `確認依頼（${inbox.questions.length}）`,
            ...inbox.questions.map(
              (q) =>
                `  ${q.issueId}  ${q.issueTitle}\n    Q: ${q.question}（${q.askedBy}）${q.worktree ? `\n    実行場所: ${q.branch ?? "(detached)"}  ${q.worktree}` : ""}`,
            ),
            "",
            `レビュー待ち（${inbox.reviews.length}）`,
            ...(() => { const width = statusColumnWidth(inbox.reviews); return inbox.reviews.map((i) => `  ${formatIssueLine(i, width)}${i.prUrl ? `  ${i.prUrl}` : ""}`); })(),
            "",
            `通知（未読 ${inbox.notifications.length}）`,
            ...inbox.notifications.map(formatNotification),
          ].join("\n"),
        );
      }),
    );

  program
    .command("answer <id> <text>")
    .description("LLM からの未回答の確認依頼にまとめて回答する。--question なら指定した質問だけに回答する")
    .option("--question <questionId>", "回答する質問の id（nod issue show の未決事項の #番号）")
    .action(
      act((cli, _cmd, id: string, text: string, o: { question?: string }) => {
        const r = answerQuestion(cli.ctx, id, text, {
          questionId: o.question === undefined ? undefined : parsePositiveInt(o.question, "質問の id"),
        });
        print(cli, r, () => `回答しました（${r.answered.length} 件）: ${formatIssueLine(r.issue)}`);
      }),
    );

  const notification = program.command("notification").description("購読中の Issue の変化と、LLM に任せた Issue の完了・入力待ち・エラーの通知を扱う");
  notification
    .command("list")
    .description("通知を新しい順に一覧する（既定は未読だけ）")
    .option("--include-read", "既読の通知も含める")
    .option("--snoozed", "スヌーズ中の通知だけを一覧する（既読も含む）")
    .action(
      act((cli, _cmd, o: { includeRead?: boolean; snoozed?: boolean }) => {
        if (o.includeRead && o.snoozed) throw new NodError("INVALID_ARGS", "--include-read と --snoozed は同時に指定できません");
        const list = listNotifications(cli.db, { includeRead: o.includeRead === true, snoozed: o.snoozed === true });
        print(cli, list, () => (list.length ? list.map(formatNotification).join("\n") : "通知はありません"));
      }),
    );
  notification
    .command("read [ids...]")
    .description("通知を既読にする。id（nod notification list の #番号）・--issue・--all のどれか1つで指定する")
    .option("--issue <id>", "この Issue の通知をすべて既読にする")
    .option("--all", "すべての通知を既読にする")
    .action(
      act((cli, _cmd, ids: string[], o: { issue?: string; all?: boolean }) => {
        const r = markNotificationsRead(cli.ctx, {
          ids: ids.length ? ids.map((id) => parsePositiveInt(id, "通知の id")) : undefined,
          issueRef: o.issue,
          all: o.all,
        });
        print(cli, r, () => `${r.updated} 件を既読にしました`);
      }),
    );

  notification
    .command("snooze [ids...]")
    .description("通知を指定した日時までスヌーズする。期限が来ると Issue ごとに最新の1件を未読として出し直す。id か --issue で指定する")
    .requiredOption("--until <日時>", "期限（例: 2026-10-01、2026-10-01T09:00:00+09:00）")
    .option("--issue <id>", "この Issue の通知をまとめてスヌーズする")
    .action(
      act((cli, _cmd, ids: string[], o: { until: string; issue?: string }) => {
        const r = snoozeNotifications(cli.ctx, { ...notificationTarget(ids, o.issue), until: o.until });
        print(cli, r, () => `${r.updated} 件を ${r.snoozedUntil} までスヌーズしました`);
      }),
    );
  notification
    .command("unsnooze [ids...]")
    .description("通知のスヌーズを解除して、すぐ一覧に戻す。id か --issue で指定する")
    .option("--issue <id>", "この Issue の通知のスヌーズをまとめて解除する")
    .action(
      act((cli, _cmd, ids: string[], o: { issue?: string }) => {
        const r = unsnoozeNotifications(cli.ctx, notificationTarget(ids, o.issue));
        print(cli, r, () => `${r.updated} 件のスヌーズを解除しました`);
      }),
    );

  notification
    .command("delete [ids...]")
    .description("通知を削除する（一覧から消す）。後から同じ Issue に届いた通知は新しく出る。id か --issue で指定する")
    .option("--issue <id>", "この Issue の通知をまとめて削除する")
    .action(
      act((cli, _cmd, ids: string[], o: { issue?: string }) => {
        const r = deleteNotifications(cli.ctx, notificationTarget(ids, o.issue));
        print(cli, r, () => `${r.updated} 件を削除しました（取り消すには nod notification restore ${r.ids.join(" ")}）`);
      }),
    );
  notification
    .command("restore <ids...>")
    .description("通知の削除を取り消す。id は nod notification delete が表示したもの")
    .action(
      act((cli, _cmd, ids: string[]) => {
        const r = restoreNotifications(cli.ctx, { ids: ids.map((id) => parsePositiveInt(id, "通知の id")) });
        print(cli, r, () => `${r.updated} 件の削除を取り消しました`);
      }),
    );

  const triage = program.command("triage").description("Triage の Issue を判断する");
  triage
    .command("accept <id>")
    .description("受け入れて Todo にする")
    .option("--assignee <name>", "受け入れと同時に担当を設定する")
    .action(
      act((cli, _cmd, id: string, o: { assignee?: string }) => {
        const issue = acceptTriage(cli.ctx, id, { assignee: o.assignee });
        print(cli, issue, () => `受け入れました: ${formatIssueLine(issue)}`);
      }),
    );
  triage
    .command("decline <id>")
    .description("却下する（Canceled にする）")
    .option("--reason <text>", "理由")
    .action(
      act((cli, _cmd, id: string, o: { reason?: string }) => {
        const issue = declineTriage(cli.ctx, id, o.reason);
        print(cli, issue, () => `却下しました: ${formatIssueLine(issue)}`);
      }),
    );
  triage
    .command("duplicate <id> <originalId>")
    .description("既存の Issue の重複として Canceled にする")
    .action(
      act((cli, _cmd, id: string, originalId: string) => {
        const issue = duplicateTriage(cli.ctx, id, originalId);
        print(cli, issue, () => `${originalId} の重複にしました: ${formatIssueLine(issue)}`);
      }),
    );
  triage
    .command("suggest <id>")
    .description("重複・ラベル・担当の候補を根拠つきで出す（読み取りのみ。採用は人が accept / duplicate で行う）")
    .action(
      act((cli, _cmd, id: string) => {
        const s = suggestTriage(cli.ctx, id);
        print(cli, s, () => formatTriageSuggestions(s));
      }),
    );
  triage
    .command("snooze <id> <until>")
    .description("指定した日時まで後回しにする（例: 2026-10-01、2026-10-01T09:00:00+09:00）")
    .action(
      act((cli, _cmd, id: string, until: string) => {
        const issue = snoozeTriage(cli.ctx, id, until);
        print(cli, issue, () => `${issue.snoozedUntil} まで後回しにしました: ${formatIssueLine(issue)}`);
      }),
    );

  const review = program.command("review").description("In Review の Issue を判断する");
  review
    .command("approve <id>")
    .description("承認して Done にする")
    .action(
      act((cli, _cmd, id: string) => {
        const issue = approveReview(cli.ctx, id);
        print(cli, issue, () => `承認しました: ${formatIssueLine(issue)}`);
      }),
    );
  review
    .command("reject <id> <text>")
    .description("差し戻しの理由を残して In Progress に戻す")
    .action(
      act((cli, _cmd, id: string, text: string) => {
        const issue = rejectReview(cli.ctx, id, text);
        print(cli, issue, () => `差し戻しました: ${formatIssueLine(issue)}`);
      }),
    );
}
