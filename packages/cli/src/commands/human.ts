import { collect, parsePositiveInt, parsePriority, parseStatuses } from "../args";
import {
  acceptTriage,
  answerQuestion,
  approveReview,
  declineTriage,
  deleteNotifications,
  duplicateTriage,
  getInbox,
  getPrStatus,
  HUMAN_ACTOR,
  listOpenQuestions,
  listTriage,
  listTriageProposals,
  listNotifications,
  localMinute,
  NOTIFICATION_READ_LIMIT,
  listReminders,
  markNotificationsRead,
  markNotificationsUnread,
  NodError,
  parseOpenQuestionAsker,
  proposeTriage,
  withdrawTriageProposal,
  rejectReview,
  restoreNotifications,
  snoozeNotifications,
  snoozeTriage,
  suggestTriage,
  unsnoozeNotifications,
} from "@nod/core";
import type { Command } from "commander";
import { act, currentWorkspace, globalOpts } from "../context";
import { formatApprovalGithub, formatIssueLine, formatIssueLines, formatNotification, formatOpenQuestions, formatTriageProposal, formatTriageProposals, formatTriageSuggestions, print, statusColumnWidth } from "../output";

// 通知を操作する対象。id（nod notification list の #番号）か --issue
function notificationTarget(ids: string[], issue: string | undefined): { ids?: number[]; issueRef?: string } {
  return { ids: ids.length ? ids.map((id) => parsePositiveInt(id, "通知の id")) : undefined, issueRef: issue };
}

export function registerHumanCommands(program: Command): void {
  program
    .command("inbox")
    .description("全 Workspace の LLM からの確認依頼とレビュー待ち、購読中の Issue と LLM に任せた Issue の未読の通知を一覧し、Triage の件数を出す")
    .action(
      act((cli) => {
        // Triage は件数だけを出す（Web の Sidebar と同じく、スヌーズ中を除く。#177）
        const inbox = { ...getInbox(cli.db), notifications: listNotifications(cli.db), triageCount: listTriage(cli.db).length };
        // 確認依頼に出ている Issue の「入力待ち」の通知は、同じ質問が2か所に並ぶのでテキスト表示では省く（#176）。
        // 通知そのものは残り、nod notification list と --json には出る
        const asked = new Set(inbox.questions.map((q) => q.issueId));
        const shown = inbox.notifications.filter((n) => !(n.kind === "agent" && n.data.to === "awaiting_input" && asked.has(n.issueId)));
        const omitted = inbox.notifications.length - shown.length;
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
            `通知（未読 ${shown.length}）`,
            ...shown.map(formatNotification),
            ...(omitted > 0 ? [`  （確認依頼に出ている入力待ちの通知 ${omitted} 件は省略）`] : []),
            "",
            `Triage（${inbox.triageCount}）${inbox.triageCount > 0 ? "  nod triage list で一覧" : ""}`,
          ].join("\n"),
        );
      }),
    );

  program
    .command("questions")
    .description("未回答の未決事項（確認依頼）を、人が付けたものも含めて Issue 横断で一覧する（既定ですべての Workspace、-w で絞る）。回答は nod answer --question で行う。読み取り専用")
    .option("--asked-by <me|llm>", "質問者で絞る（me は人が付けたもの、llm は LLM からのもの。既定は両方）")
    .option("--project <project>", "Project の名前か ID")
    .option("-s, --status <statuses>", "Issue のステータス（カンマ区切り。done と canceled は指定できない）")
    .option("--query <text>", "Issue のタイトル・ID・質問文で検索（合った Issue の未回答の質問をすべて出す）")
    .option("--limit <n>", "出す Issue の数（既定はすべて。超えた分は「ほか N Issue」）")
    .action(
      act((cli, cmd, o: { askedBy?: string; project?: string; status?: string; query?: string; limit?: string }) => {
        const result = listOpenQuestions(cli.db, {
          askedBy: o.askedBy === undefined ? undefined : parseOpenQuestionAsker(o.askedBy),
          workspace: globalOpts(cmd).workspace ? [currentWorkspace(cli, cmd).key] : undefined,
          project: o.project,
          status: o.status ? parseStatuses(o.status) : undefined,
          q: o.query,
          limit: o.limit === undefined ? undefined : parsePositiveInt(o.limit, "--limit"),
        });
        print(cli, result, () => formatOpenQuestions(result, cli.ctx.actor !== HUMAN_ACTOR));
      }),
    );

  program
    .command("answer <id> <text>")
    .description("LLM からの未回答の確認依頼にまとめて回答する。--question なら指定した質問だけに回答する（me が付けた未決事項に回答できるのは me だけ）")
    .option("--question <questionId>", "回答する質問の id（nod issue show の未決事項の #番号）")
    .action(
      act((cli, _cmd, id: string, text: string, o: { question?: string }) => {
        const r = answerQuestion(cli.ctx, id, text, {
          questionId: o.question === undefined ? undefined : parsePositiveInt(o.question, "質問の id"),
        });
        print(cli, r, () => `回答しました（${r.answered.length} 件）: ${formatIssueLine(r.issue)}`);
      }),
    );

  const notification = program.command("notification").description("購読中の Issue の変化、LLM に任せた Issue の完了・入力待ち・エラー、リマインダーの通知を扱う");
  notification
    .command("list")
    .description("通知を新しい順に一覧する（既定は未読だけ）")
    .option("--include-read", "既読の通知も含める")
    .option("--snoozed", "スヌーズ中の通知だけを一覧する（既読も含む）")
    .option("--limit <n>", `既読の通知を最近既読にしたものから何件まで出すか（既定 ${NOTIFICATION_READ_LIMIT}。未読はすべて出す）`)
    .action(
      act((cli, _cmd, o: { includeRead?: boolean; snoozed?: boolean; limit?: string }) => {
        if (o.includeRead && o.snoozed) throw new NodError("INVALID_ARGS", "--include-read と --snoozed は同時に指定できません");
        if (o.limit !== undefined && !o.includeRead && !o.snoozed) {
          throw new NodError("INVALID_ARGS", "--limit は --include-read か --snoozed と一緒に指定してください");
        }
        const list = listNotifications(cli.db, {
          includeRead: o.includeRead === true,
          snoozed: o.snoozed === true,
          readLimit: o.limit === undefined ? undefined : parsePositiveInt(o.limit, "--limit"),
        });
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
    .command("unread [ids...]")
    .description("既読の通知を未読に戻す。id（nod notification list --include-read の #番号）か --issue で指定する")
    .option("--issue <id>", "この Issue の最新の通知1件を未読に戻す")
    .action(
      act((cli, _cmd, ids: string[], o: { issue?: string }) => {
        const r = markNotificationsUnread(cli.ctx, notificationTarget(ids, o.issue));
        print(cli, r, () => `${r.updated} 件を未読に戻しました`);
      }),
    );

  notification
    .command("snooze [ids...]")
    .description("通知を指定した日時までスヌーズする。期限が来ると Issue ごとに最新の1件を未読として出し直す。id か --issue で指定する")
    .requiredOption("--until <日時>", "期限（例: 2026-10-01、2026-10-01 09:00、2026-10-01T09:00:00+09:00）")
    .option("--issue <id>", "この Issue の通知をまとめてスヌーズする")
    .action(
      act((cli, _cmd, ids: string[], o: { until: string; issue?: string }) => {
        const r = snoozeNotifications(cli.ctx, { ...notificationTarget(ids, o.issue), until: o.until });
        print(cli, r, () => `${r.updated} 件を ${localMinute(r.snoozedUntil)} までスヌーズしました`);
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
        print(cli, r, () => `${r.updated} 件の削除を取り消しました${r.missing ? `（${r.missing} 件はもうないため読み飛ばしました）` : ""}`);
      }),
    );

  program
    .command("reminder")
    .description("リマインダー（nod issue remind）")
    .command("list")
    .description("まだ届いていないリマインダーを期限の近い順に一覧する（アーカイブ済みの Issue のものは除く）。期限が来たものは通知に変わる")
    .action(
      act((cli) => {
        const list = listReminders(cli.db);
        print(cli, list, () =>
          list.length
            ? list.map((r) => `  ${localMinute(r.remindAt)}  ${r.issueId}  ${r.issueTitle}${r.note ? `\n    ${r.note}` : ""}`).join("\n")
            : "リマインダーはありません",
        );
      }),
    );

  const triage = program.command("triage").description("Triage の Issue を判断する");
  triage
    .command("list")
    .description("全 Workspace の Triage の Issue を一覧する（スヌーズ中を除く。読み取りのみ）")
    .action(
      act((cli) => {
        const list = listTriage(cli.db);
        print(cli, list, () => (list.length ? formatIssueLines(list).join("\n") : "Triage の Issue はありません"));
      }),
    );
  triage
    .command("accept <id>")
    .description("受け入れて Todo にする")
    .option("--assignee <name>", "受け入れと同時に担当を設定する")
    .option("--cycle <cycle>", "Cycle の ID・名前・current（現在の Cycle）。空文字で外す")
    .action(
      act((cli, _cmd, id: string, o: { assignee?: string; cycle?: string }) => {
        const issue = acceptTriage(cli.ctx, id, { assignee: o.assignee, cycleRef: o.cycle });
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
    .command("propose <id>")
    .description("受け入れ・却下・重複の推奨を記録する（Triage の状態は変えない。確定は人が accept / decline / duplicate で行う）")
    .option("--accept", "受け入れを推奨する")
    .option("--decline", "却下を推奨する")
    .option("--duplicate-of <originalId>", "元の Issue の重複として閉じることを推奨する")
    .option("-l, --label <label>", "受け入れ時に付けるラベル（繰り返し可。--accept のときだけ）", collect)
    .option("--assignee <name>", "受け入れ時の担当（--accept のときだけ）")
    .option("-p, --priority <priority>", "受け入れ時の優先度（--accept のときだけ。0〜4、P0〜P4、urgent・high・medium・low・none のどれか）")
    .option("--project <project>", "受け入れ時の Project の名前か ID（--accept のときだけ）")
    .option("--reason <text>", "判断の理由")
    .option("--withdraw", "自分の提案を取り下げる（他の書き手の提案は消せない。ほかのオプションとは併用できない）")
    .action(
      act(
        (
          cli,
          _cmd,
          id: string,
          o: {
            accept?: boolean;
            decline?: boolean;
            duplicateOf?: string;
            label?: string[];
            assignee?: string;
            priority?: string;
            project?: string;
            reason?: string;
            withdraw?: boolean;
          },
        ) => {
          if (o.withdraw) {
            const { withdraw: _, ...rest } = o;
            if (Object.values(rest).some((v) => v !== undefined)) throw new NodError("INVALID_ARGS", "--withdraw はほかのオプションと併用できません");
            const r = withdrawTriageProposal(cli.ctx, id);
            print(cli, r, () => `${r.issueId} の ${r.actor} の提案を取り下げました`);
            return;
          }
          const picked = [o.accept && "accept", o.decline && "decline", o.duplicateOf !== undefined && "duplicate"].filter(Boolean);
          if (picked.length !== 1) throw new NodError("INVALID_ARGS", "--accept・--decline・--duplicate-of <id> のどれか1つを指定してください");
          const p = proposeTriage(cli.ctx, id, {
            decision: picked[0] as "accept" | "decline" | "duplicate",
            duplicateOf: o.duplicateOf,
            labels: o.label,
            assignee: o.assignee,
            priority: o.priority === undefined ? undefined : parsePriority(o.priority),
            projectRef: o.project,
            reason: o.reason,
          });
          print(cli, p, () => `提案を記録しました（確定は人が行います）: ${formatTriageProposal(p)}`);
        },
      ),
    );
  triage
    .command("proposals <id>")
    .description("記録された提案を新しい順に出す（読み取りのみ）")
    .action(
      act((cli, _cmd, id: string) => {
        const list = listTriageProposals(cli.ctx.db, id);
        print(cli, list, () => formatTriageProposals(id, list));
      }),
    );
  triage
    .command("snooze <id> <until>")
    .description("指定した日時まで後回しにする（例: 2026-10-01、2026-10-01 09:00、2026-10-01T09:00:00+09:00）")
    .action(
      act((cli, _cmd, id: string, until: string) => {
        const issue = snoozeTriage(cli.ctx, id, until);
        print(cli, issue, () => `${issue.snoozedUntil ? localMinute(issue.snoozedUntil) : ""} まで後回しにしました: ${formatIssueLine(issue)}`);
      }),
    );

  const review = program.command("review").description("In Review の Issue を判断する");
  review
    .command("list")
    .description("全 Workspace のレビュー待ち（In Review）の Issue を一覧する（読み取りのみ）")
    .action(
      act((cli) => {
        const { reviews } = getInbox(cli.db);
        const width = statusColumnWidth(reviews);
        print(cli, reviews, () =>
          reviews.length ? reviews.map((i) => `${formatIssueLine(i, width)}${i.prUrl ? `  ${i.prUrl}` : ""}`).join("\n") : "レビュー待ちの Issue はありません",
        );
      }),
    );
  review
    .command("approve <id>")
    .description("承認して Done にする（nod の承認で、GitHub の PR の承認・マージではない）")
    .action(
      act((cli, _cmd, id: string) => {
        const issue = approveReview(cli.ctx, id);
        // GitHub 側の状態は保存済みの結果を添えるだけで、gh は実行しない（#56/#57）
        print(cli, issue, () => [`承認しました: ${formatIssueLine(issue)}`, ...formatApprovalGithub(getPrStatus(cli.db, issue.id))].join("\n"));
      }),
    );
  review
    .command("reject <id> <text>")
    .description("差し戻しの理由を残して In Progress に戻す")
    .option("--delegate <kind>", "LLM に対応を依頼する（review_fix: 指摘対応、rebase）。理由を対応依頼として記録し、LLM は start / show で読む")
    .action(
      act((cli, cmd, id: string, text: string) => {
        const { delegate } = cmd.opts<{ delegate?: string }>();
        if (delegate !== undefined && delegate !== "review_fix" && delegate !== "rebase") {
          throw new NodError("INVALID_ARGS", "--delegate は review_fix（指摘対応）か rebase で指定してください");
        }
        const issue = rejectReview(cli.ctx, id, text, { delegate });
        print(cli, issue, () =>
          issue.instruction
            ? `差し戻しました: ${formatIssueLine(issue)}\n対応依頼を記録しました（#${issue.instruction.id}）。Orca の端末へ送るときは web の Issue 詳細から送信します`
            : `差し戻しました: ${formatIssueLine(issue)}`,
        );
      }),
    );
}
