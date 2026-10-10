import type { Database } from "bun:sqlite";
import {
  acknowledgeShownInstructions,
  addFileAttachment,
  addLinkAttachment,
  archiveIssue,
  askQuestion,
  type AskResult,
  attachDocument,
  bulkUpdateIssues,
  clearReminder,
  commentIssue,
  completeIssue,
  copyIssue,
  createIssue,
  assessCreatedIssue,
  retryIssueAssessment,
  detachDocument,
  diagnoseIssues,
  failIssue,
  formatTransitionRulesSection,
  formatWorkspaceRulesSection,
  deleteIssue,
  findDeletableIssueRow,
  formatIssueId,
  getIssue,
  getIssueBranchName,
  getPrStatus,
  createCommandRunner,
  linkPr,
  localMinute,
  refreshPrStatus,
  getPrDiff,
  getPrDiffFile,
  refreshPrDiff,
  getTransitionRules,
  getWorkspaceRules,
  importPlan,
  isLlm,
  type Issue,
  listInstructions,
  listIssueAttachments,
  ISSUE_SORT_KEYS,
  listIssues,
  logWork,
  nextIssue,
  NodError,
  parseIssueSortKey,
  parsePriorityRefs,
  sortIssues,
  recordInstruction,
  relateIssue,
  removeAttachment,
  resolveThread,
  setPlanTasks,
  setReminder,
  setStep,
  startIssue,
  subscribeIssue,
  suggestIssue,
  takePendingInstructions,
  getPendingRejection,
  unarchiveIssue,
  unsubscribeIssue,
  updateIssue,
  validateStaleDays,
  WORK_LOG_KIND_LABEL,
  WORK_LOG_KINDS,
  type WorkspaceRules,
  type WorkspaceTransitionRules,
} from "@nod/core";
import type { Command } from "commander";
import { collect, orNull, parseAssignees, parseDocKind, parseEstimate, parsePositiveInt, parsePriority, PRIORITY_HELP, parseStatus, parseStatuses, parseStepStatus } from "../args";
import { act, actAsync, type Cli, currentWorkspace, globalOpts } from "../context";
import { registerGithubIssueCommands } from "./github";
import { currentWorkLocation, notifyOrca, type OrcaUpdate } from "../orca";
import {
  formatAttachment,
  formatDelegations,
  formatIssueDetail,
  formatSpecAssessment,
  formatIssueLine,
  formatIssueLines,
  formatIssueListLines,
  formatInstructions,
  formatRejection,
  formatPlan,
  formatPrStatus,
  formatPrDiff,
  formatPrDiffFile,
  formatPrStatusLine,
  print,
  sortByAssignee,
  statusColumnWidth,
  statusText,
} from "../output";

// Orca のカードは LLM 向けのコマンドで LLM が操作したときだけ更新する
async function notifyIfLlm(cli: Cli, update: OrcaUpdate): Promise<void> {
  if (isLlm(cli.ctx)) await notifyOrca(update);
}

// 更新後の状態が todo・backlog の Issue に残る未回答の確認依頼の件数（状態を変えたかは問わない）。残る間は着手できないので、成功表示に添える（#170）
function heldQuestionCount(i: Issue): number {
  if (i.status !== "todo" && i.status !== "backlog") return 0;
  return i.questionCount.total - i.questionCount.answered;
}

export function registerIssueCommands(program: Command): void {
  const issue = program.command("issue").description("Issue を操作する");

  issue
    .command("create <title>")
    .description("Issue を起票する（LLM の起票は Triage に入る）")
    .option("-d, --description <text>", "説明")
    .option("--template <name>", "テンプレートの本文を説明の初期値にする（-d とは同時に使えない）")
    .option("--project <project>", "Project の名前か ID")
    .option("--milestone <milestone>", "Milestone の名前か ID（--project の Project のもの）")
    .option("--cycle <cycle>", "Cycle の ID・名前・current（現在の Cycle）")
    .option("--parent <id>", "親 Issue（Sub-issue として作る）")
    .option("--discovered-from <id>", "発見元の Issue")
    .option("-p, --priority <priority>", PRIORITY_HELP)
    .option("--estimate <1-100>", "見積もり（ポイント）")
    .option("--due <YYYY-MM-DD>", "期限（日付。1900-01-01 以降）")
    .option("-l, --label <label>", "ラベル（繰り返し可）", collect)
    .action(
      actAsync(
        async (
          cli,
          cmd,
          title: string,
          o: { template?: string; description?: string; project?: string; milestone?: string; cycle?: string; parent?: string; discoveredFrom?: string; priority?: string; estimate?: string; due?: string; label?: string[] },
        ) => {
          const created = createIssue(cli.ctx, {
            workspaceId: currentWorkspace(cli, cmd).id,
            title,
            description: o.description,
            template: o.template,
            projectRef: o.project,
            milestoneRef: o.milestone,
            cycleRef: o.cycle,
            parentRef: o.parent,
            discoveredFromRef: o.discoveredFrom,
            priority: o.priority === undefined ? undefined : parsePriority(o.priority),
            estimate: o.estimate === undefined ? undefined : parseEstimate(o.estimate),
            dueDate: o.due,
            labels: o.label,
          });
          const assessed = await assessCreatedIssue(cli.ctx, created.id);
          print(cli, assessed, () => `起票しました: ${formatIssueLine(assessed)}\n${formatSpecAssessment(assessed)}`);
        },
      ),
    );

  issue
    .command("assess <id>")
    .description("仕様要否を明示判定・再試行する（判定済みの場合は記録のみ）")
    .action(actAsync(async (cli, _cmd, id: string) => {
      const assessed = await retryIssueAssessment(cli.ctx, id);
      print(cli, assessed, () => formatSpecAssessment(assessed));
    }));

  issue
    .command("copy <id>")
    .description("Issue を複製する（タイトル・説明・Project・ラベル・優先度・見積もりだけを引き継ぎ、元の Issue は変えない）")
    .option("--title <text>", "複製のタイトル（省くと元のタイトル）")
    .action(
      act((cli, _cmd, id: string, o: { title?: string }) => {
        const copied = copyIssue(cli.ctx, id, { title: o.title });
        print(cli, copied, () => `${id.toUpperCase()} から複製しました: ${formatIssueLine(copied)}`);
      }),
    );

  issue
    .command("archive <id>")
    .description("Issue をアーカイブする（ステータスは変えず、既定の一覧・ボード・Inbox・next から外す。人だけが行える）")
    .option("--reason <text>", "アーカイブの理由（Activity に残る）")
    .action(
      act((cli, _cmd, id: string, o: { reason?: string }) => {
        const archived = archiveIssue(cli.ctx, id, { reason: o.reason });
        print(cli, archived, () => `${archived.id} をアーカイブしました（nod issue unarchive ${archived.id} で戻せます）`);
      }),
    );

  issue
    .command("unarchive <id>")
    .description("アーカイブした Issue を元に戻す（ステータスはアーカイブ前のまま。人だけが行える）")
    .action(
      act((cli, _cmd, id: string) => {
        const restored = unarchiveIssue(cli.ctx, id);
        print(cli, restored, () => `${restored.id} を復元しました: ${formatIssueLine(restored)}`);
      }),
    );

  issue
    .command("delete <id>")
    .description("アーカイブ済みの Issue を完全に削除する（元に戻せない。Workspace の監査ログに残る。人だけが行える）")
    .option("--yes", "確認なしで削除する")
    .action(
      act((cli, _cmd, id: string, o: { yes?: boolean }) => {
        const row = findDeletableIssueRow(cli.ctx, id);
        if (!o.yes) {
          const issueId = formatIssueId(row.ws_key, row.number);
          throw new NodError(
            "CONFIRM_REQUIRED",
            `${issueId}「${row.title}」を完全に削除すると、コメント・添付・履歴も消え、元に戻せません。よければ --yes を付けて再実行してください`,
          );
        }
        const deleted = deleteIssue(cli.ctx, id);
        print(cli, deleted, () => `${deleted.issueId}「${deleted.title}」を完全に削除しました（nod workspace audit で記録を確かめられます）`);
      }),
    );

  issue
    .command("list")
    .description("Issue を一覧する（既定では done と canceled を除く）")
    .option("-s, --status <statuses>", "ステータス（カンマ区切り）")
    .option("--project <project>", "Project の名前か ID")
    .option("--milestone <milestone>", "Milestone の ID か none（Milestone なし）。名前は --project を指定したとき")
    .option("--cycle <cycle>", "Cycle の ID・名前・current か none（Cycle なし）")
    .option("-l, --label <label>", "ラベル（繰り返し可、すべてを満たすもの）", collect)
    .option("--query <text>", "ID・タイトル・説明で検索")
    .option("--all-workspaces", "すべての Workspace の Issue を出す")
    .option("--completion-candidates", "Sub-issue がすべて完了した親（完了候補）だけを出す")
    .option("--archived", "アーカイブ済みの Issue だけを出す（--status を省くとすべてのステータス）")
    .option("--ready", "着手できる Issue だけを出す（todo で、スヌーズ中でなく、未回答の確認依頼も未完了のブロック元もないもの。担当は問わない。Web の Ready と同じ条件）")
    .option("--delegated", "LLM に委任中（担当が LLM で done/canceled 以外）の Issue を LLM ごとに出す（既定ですべての Workspace、-w で絞る）")
    .option("--assignee <name>", "担当で絞る（繰り返し可・カンマ区切り可、どれかに合うもの。none は未割り当て）", collect)
    .option("--mine", "自分が担当の Issue だけを出す（人なら me、LLM なら自分の名前。既定ですべての Workspace、-w で絞る）")
    .option("--priority <priorities>", "優先度で絞る（0〜4、P0〜P4、urgent・high・medium・low・none のどれか。繰り返し可・カンマ区切り可、どれかに合うもの。0 と none は優先度なし）", collect)
    .option("--sort <key>", `並び順（${ISSUE_SORT_KEYS.join("|")}。既定は id。default は 状態 → 優先度 → ID）`)
    .option("--desc", "降順にする（同順位は ID の昇順。見積もり・期限の未設定は末尾のまま）")
    .action(
      act(
        (
          cli,
          cmd,
          o: { status?: string; project?: string; milestone?: string; cycle?: string; label?: string[]; allWorkspaces?: boolean; query?: string; ready?: boolean; delegated?: boolean; assignee?: string[]; mine?: boolean; completionCandidates?: boolean; archived?: boolean; priority?: string[]; sort?: string; desc?: boolean },
        ) => {
          // 委任中と自分の担当の一覧はどこからでも見られるよう、-w がなければ Workspace で絞らない
          const allWorkspaces = o.allWorkspaces || ((o.delegated || o.mine) && !globalOpts(cmd).workspace);
          const assignees = [...(o.assignee ? parseAssignees(o.assignee) : []), ...(o.mine ? [cli.ctx.actor] : [])];
          const priorities = o.priority ? parsePriorityRefs(o.priority) : undefined;
          if (o.priority && !priorities) {
            throw new NodError("INVALID_ARGS", "--priority には 0〜4、P0〜P4、urgent・high・medium・low・none のどれかを指定してください");
          }
          const sort = o.sort === undefined ? "id" : parseIssueSortKey(o.sort);
          const listed = listIssues(cli.db, {
            priorities,
            query: o.query,
            workspaceId: allWorkspaces ? undefined : currentWorkspace(cli, cmd).id,
            statuses: o.status ? parseStatuses(o.status) : undefined,
            projectRef: o.project,
            milestone: o.milestone,
            cycleRef: o.cycle,
            labels: o.label,
            ready: o.ready,
            delegated: o.delegated,
            assignees: assignees.length ? assignees : undefined,
            completionCandidate: o.completionCandidates,
            archived: o.archived,
          });
          // listIssues は ID の順で返すので、既定（id の昇順）のときは並べ直さない
          const sorted = sort === "id" && !o.desc ? listed : sortIssues(listed, sort, o.desc ? "desc" : "asc");
          // 検索語が ID と完全一致する Issue は、並び順に関係なく先頭に置く（TS-6 の検索で TS-60 より後ろに埋もれないように。#176）
          const exactId = o.query?.trim().toLowerCase() ?? "";
          const issues = exactId ? [...sorted.filter((i) => i.id.toLowerCase() === exactId), ...sorted.filter((i) => i.id.toLowerCase() !== exactId)] : sorted;
          if (o.delegated) {
            const byAssignee = sortByAssignee(issues);
            print(cli, byAssignee, () => formatDelegations(byAssignee));
            return;
          }
          print(cli, issues, () => (issues.length ? formatIssueListLines(issues).join("\n") : "Issue はありません"));
        },
      ),
    );

  issue
    .command("show <id>")
    .description("Issue の詳細（計画、Documents、添付、Activity を含む）を表示する")
    .action(
      act((cli, _cmd, id: string) => {
        const detail = getIssue(cli.db, id);
        // 担当の LLM が読んだ未確認の追加指示は確認済みにする（表示は読んだ時点の「未確認」のまま）
        acknowledgeShownInstructions(cli.ctx, detail.id, detail.pendingInstructions);
        const rules = workspaceGuidance(cli.db, detail.workspace);
        const pr = formatPrStatusLine(getPrStatus(cli.db, detail.id));
        print(cli, withRules(detail, rules), () => withRulesText(formatIssueDetail(detail, pr), rules));
      }),
    );

  issue
    .command("pr-status <id>")
    .description("PR の状態（レビュー・CI・マージ）を表示する。--refresh で gh から取得して保存する（GitHub へは読み取りのみ）")
    .option("--refresh", "gh pr view を実行して最新の状態を取得する")
    .action(
      actAsync(async (cli, cmd, id: string) => {
        const { refresh } = cmd.opts<{ refresh?: boolean }>();
        // NOD_GH はテスト用の口: gh の代わりに起動するコマンド（CLI テストが偽の gh を使い、実 GitHub に触れないため）。通常は設定しない
        const view = refresh
          ? await refreshPrStatus(cli.ctx, id, createCommandRunner(process.env.NOD_GH || "gh"))
          : getPrStatus(cli.db, id);
        print(cli, view, () => formatPrStatus(view));
      }),
    );

  issue
    .command("pr-diff <id>")
    .description("PR の変更ファイルと差分を表示する。--refresh で gh から取得して保存する（GitHub へは読み取りのみ）")
    .option("--refresh", "gh で PR の HEAD に固定した差分を取得する")
    .option("--file <path>", "このファイル（変更後のパス）の差分だけを表示する")
    .action(
      actAsync(async (cli, cmd, id: string) => {
        const { refresh, file } = cmd.opts<{ refresh?: boolean; file?: string }>();
        // NOD_GH はテスト用の口（pr-status と同じ）
        const view = refresh ? await refreshPrDiff(cli.ctx, id, createCommandRunner(process.env.NOD_GH || "gh")) : getPrDiff(cli.db, id);
        if (file === undefined) {
          print(cli, view, () => formatPrDiff(view));
          return;
        }
        const found = getPrDiffFile(cli.db, id, file);
        print(cli, found, () => formatPrDiffFile(found));
      }),
    );

  issue
    .command("link-pr <id> <url>")
    .description("作業中の Issue に PR（draft を含む）を紐付ける。ステータスは変えない（draft PR を作った時点で使う）")
    .addHelpText(
      "after",
      "\nWorkspace で PR 連動（nod automation set --pr-review on）が有効なら、紐付けたあとの nod issue pr-status --refresh で\nPR が open（draft 以外）かマージ済みのとき in_progress を in_review に進める（done にはしない）。",
    )
    .action(
      act((cli, _cmd, id: string, url: string) => {
        const r = linkPr(cli.ctx, id, url);
        print(cli, r, () => `${r.id} に PR ${r.prUrl} を紐付けました（ステータス: ${r.status}）`);
      }),
    );

  issue
    .command("branch-name <id>")
    .description("Issue 用のブランチ名を取得する（ブランチ作成・着手・記録変更はしない）")
    .action(
      act((cli, _cmd, id: string) => {
        const name = getIssueBranchName(cli.db, id);
        print(cli, name, () => name.suggestedBranch);
      }),
    );
  registerGithubIssueCommands(issue);

  issue
    .command("update <id>")
    .description("Issue のプロパティを変える（空文字を渡すと外す）")
    .option("--title <text>", "タイトル")
    .option("-d, --description <text>", "説明")
    .option("-p, --priority <priority>", PRIORITY_HELP)
    .option("--estimate <1-100>", "見積もり（ポイント）")
    .option("--due <YYYY-MM-DD>", "期限（日付。1900-01-01 以降）")
    .option("-s, --status <status>", "ステータス")
    .option("--assignee <name>", "担当（空文字で外す。none は未割り当ての絞り込み用の予約語で使えない）")
    .option("--parent <id>", "親 Issue")
    .option("--project <project>", "Project の名前か ID")
    .option("--milestone <milestone>", "Milestone の名前か ID（Issue の Project のもの。Project を変えると外れる）")
    .option("--cycle <cycle>", "Cycle の ID・名前・current（空文字で外す）")
    .option("--add-label <label>", "ラベルを足す（繰り返し可）", collect)
    .option("--remove-label <label>", "ラベルを外す（繰り返し可）", collect)
    .option("--reason <text>", "done か canceled にするときの理由")
    .action(
      act(
        (
          cli,
          _cmd,
          id: string,
          o: {
            milestone?: string;
            title?: string;
            description?: string;
            priority?: string;
            estimate?: string;
            due?: string;
            status?: string;
            assignee?: string;
            parent?: string;
            project?: string;
            cycle?: string;
            addLabel?: string[];
            removeLabel?: string[];
            reason?: string;
          },
        ) => {
          const updated = updateIssue(cli.ctx, id, {
            title: o.title,
            description: orNull(o.description),
            priority: o.priority === undefined ? undefined : parsePriority(o.priority),
            estimate: o.estimate === undefined ? undefined : o.estimate === "" ? null : parseEstimate(o.estimate),
            dueDate: orNull(o.due),
            status: o.status === undefined ? undefined : parseStatus(o.status),
            assignee: orNull(o.assignee),
            parentRef: orNull(o.parent),
            projectRef: orNull(o.project),
            milestoneRef: orNull(o.milestone),
            cycleRef: orNull(o.cycle),
            addLabels: o.addLabel,
            removeLabels: o.removeLabel,
            reason: o.reason,
          });
          print(cli, updated, () => {
            const open = heldQuestionCount(updated);
            const note = open > 0 ? `\n未回答の確認依頼が ${open} 件残っています（すべて回答されるまで着手できません）` : "";
            return `更新しました: ${formatIssueLine(updated)}${note}`;
          });
        },
      ),
    );

  issue
    .command("bulk-update <ids...>")
    .description("複数の Issue に同じ変更をまとめて加える（空文字を渡すと外す。1件でも失敗したら何も変えない）")
    .option("-p, --priority <priority>", PRIORITY_HELP)
    .option("--estimate <1-100>", "見積もり（ポイント）")
    .option("--due <YYYY-MM-DD>", "期限（日付。1900-01-01 以降）")
    .option("-s, --status <status>", "ステータス（Triage の Issue は変えられない）")
    .option("--assignee <name>", "担当（空文字で外す。none は未割り当ての絞り込み用の予約語で使えない）")
    .option("--project <project>", "Project の名前か ID")
    .option("--milestone <milestone>", "Milestone の名前か ID（各 Issue の Project のもの。空文字で外す）")
    .option("--cycle <cycle>", "Cycle の ID・名前・current（空文字で外す）")
    .option("--add-label <label>", "ラベルを足す（繰り返し可）", collect)
    .option("--remove-label <label>", "ラベルを外す（繰り返し可）", collect)
    .option("--reason <text>", "done か canceled にするときの理由")
    .action(
      act(
        (
          cli,
          _cmd,
          ids: string[],
          o: {
            priority?: string;
            estimate?: string;
            due?: string;
            status?: string;
            assignee?: string;
            project?: string;
            milestone?: string;
            cycle?: string;
            addLabel?: string[];
            removeLabel?: string[];
            reason?: string;
          },
        ) => {
          const updated = bulkUpdateIssues(cli.ctx, ids, {
            priority: o.priority === undefined ? undefined : parsePriority(o.priority),
            estimate: o.estimate === undefined ? undefined : o.estimate === "" ? null : parseEstimate(o.estimate),
            dueDate: orNull(o.due),
            status: o.status === undefined ? undefined : parseStatus(o.status),
            assignee: orNull(o.assignee),
            projectRef: orNull(o.project),
            milestoneRef: orNull(o.milestone),
            cycleRef: orNull(o.cycle),
            addLabels: o.addLabel,
            removeLabels: o.removeLabel,
            reason: o.reason,
          });
          print(cli, updated, () => {
            const held = updated.filter((i) => heldQuestionCount(i) > 0).length;
            const note = held > 0 ? [`うち ${held} 件に未回答の確認依頼が残っています`] : [];
            return [`${updated.length} 件を更新しました`, ...formatIssueLines(updated), ...note].join("\n");
          });
        },
      ),
    );

  issue
    .command("comment <id> <text>")
    .description("コメントを書く")
    .option("--reply-to <commentId>", "このコメントのスレッドに返信する（返信への返信はスレッドの親へ付く）")
    .action(
      act((cli, cmd, id: string, text: string) => {
        const o = cmd.opts<{ replyTo?: string }>();
        const replyTo = o.replyTo === undefined ? undefined : parsePositiveInt(o.replyTo, "返信先のコメントID");
        const c = commentIssue(cli.ctx, id, text, { replyTo });
        print(cli, c, () => (c.parentId === null ? `コメントしました（#${c.id}）` : `返信しました（#${c.id} → #${c.parentId}）`));
      }),
    );

  issue
    .command("instruct <id> <text>")
    .description("LLM への追加指示を記録する（人だけが行える。送信はしない。Orca の端末への送信は web の確認画面から行う）")
    .action(
      act((cli, _cmd, id: string, text: string) => {
        const recorded = recordInstruction(cli.ctx, id, text);
        print(cli, recorded, () => `追加指示を記録しました（#${recorded.id}）。LLM は nod issue start / show で読みます`);
      }),
    );

  issue
    .command("instructions <id>")
    .description("追加指示・差し戻しの対応依頼と、その送信・確認の状態を一覧する")
    .action(
      act((cli, _cmd, id: string) => {
        const list = listInstructions(cli.db, id);
        print(cli, list, () => (list.length ? formatInstructions(list).join("\n") : "追加指示はありません"));
      }),
    );

  issue
    .command("resolve <id> <commentId>")
    .description("コメントのスレッドを解決済みにする（人だけが行える）")
    .option("--reopen", "解決済みのスレッドを未解決に戻す")
    .action(
      act((cli, cmd, id: string, commentId: string) => {
        const reopen = cmd.opts<{ reopen?: boolean }>().reopen === true;
        const c = resolveThread(cli.ctx, id, parsePositiveInt(commentId, "コメントID"), !reopen);
        print(cli, c, () => `スレッド #${c.id} を${reopen ? "未解決に戻しました" : "解決済みにしました"}`);
      }),
    );

  issue
    .command("subscribe <id>")
    .description("Issue を購読し、変化を Inbox の通知で受け取る（me だけが使える）")
    .action(
      act((cli, _cmd, id: string) => {
        const r = subscribeIssue(cli.ctx, id);
        print(cli, r, () => `${r.issueId} を購読しました`);
      }),
    );

  issue
    .command("unsubscribe <id>")
    .description("Issue の購読を解除する（届いた通知は残る）")
    .action(
      act((cli, _cmd, id: string) => {
        const r = unsubscribeIssue(cli.ctx, id);
        print(cli, r, () => `${r.issueId} の購読を解除しました`);
      }),
    );

  issue
    .command("remind <id>")
    .description("Issue にリマインダーを設定する（1 Issue に1件。設定し直すと上書き）。期限が来ると Inbox に通知が届く（me だけが使える）")
    .option("--at <日時>", "通知する日時（例: 2026-10-01 09:00、2026-10-01T09:00:00+09:00。日付だけならその日の 0 時）")
    .option("--note <メモ>", "通知に添えるメモ")
    .option("--clear", "リマインダーを解除する")
    .action(
      act((cli, _cmd, id: string, o: { at?: string; note?: string; clear?: boolean }) => {
        if (o.clear) {
          if (o.at !== undefined || o.note !== undefined) throw new NodError("INVALID_ARGS", "--clear は --at・--note と同時に指定できません");
          const r = clearReminder(cli.ctx, id);
          print(cli, r, () => (r.cleared ? `${r.issueId} のリマインダーを解除しました` : `${r.issueId} にリマインダーはありません`));
          return;
        }
        if (o.at === undefined) throw new NodError("INVALID_ARGS", "--at で日時を指定してください（解除は --clear）");
        const r = setReminder(cli.ctx, id, { at: o.at, note: o.note });
        print(cli, r, () => `${r.issueId} に ${localMinute(r.remindAt)} のリマインダーを設定しました${r.note ? `: ${r.note}` : ""}`);
      }),
    );

  issue
    .command("relate <id>")
    .description("ほかの Issue との関係を足す")
    .option("--blocks <id>", "この Issue が指定した Issue をブロックする")
    .option("--related <id>", "関連する Issue")
    .option("--duplicate-of <id>", "この Issue は指定した Issue の重複である")
    .action(
      act((cli, _cmd, id: string, o: { blocks?: string; related?: string; duplicateOf?: string }) => {
        const detail = relateIssue(cli.ctx, id, o);
        print(cli, detail, () => formatIssueDetail(detail));
      }),
    );

  issue
    .command("diagnose")
    .description("未完了の直接ブロッカーと活動記録がない候補を診断する（状態・担当・通知は変更しない）")
    .requiredOption("--stale-days <days>", "停滞候補の経過日数（正の整数・必須）", (value: string) => {
      if (!/^[0-9]+$/.test(value)) throw new NodError("INVALID_ARGS", "--stale-days は正の整数で指定してください");
      const days = Number(value);
      validateStaleDays(days);
      return days;
    })
    .option("--project <project>", "Project の中を診断する")
    .addHelpText("after", "\n停滞候補は in_progress / in_review / needs_clarification が対象です。実際の作業停止は断定しません。")
    .action(act((cli, cmd, o: { staleDays: number; project?: string }) => {
      const result = diagnoseIssues(cli.db, {
        workspaceId: currentWorkspace(cli, cmd).id, projectRef: o.project, staleDays: o.staleDays,
      });
      const width = statusColumnWidth(result.findings.map((f) => f.issue));
      print(cli, result, () => result.findings.length
        ? result.findings.map(({ issue, reasons }) => `${formatIssueLine(issue, width)}\n  ${reasons.map(reason => reason.type === "blocked"
          ? `未完了の直接ブロッカー: ${reason.blockedBy.join(", ")}`
          : `${reason.inactiveDays}日間、活動記録がない候補（作業停止の断定ではありません）`).join(" / ")}`).join("\n")
        : "ブロッカー・停滞候補はありません");
    }));

  issue
    .command("suggest")
    .description("着手できる Issue を1件提案する（着手・予約・通知はしない）")
    .option("--project <project>", "Project の中から提案する")
    .action(
      act((cli, cmd, o: { project?: string }) => {
        const picked = suggestIssue(cli.ctx, {
          workspaceId: currentWorkspace(cli, cmd).id,
          projectRef: o.project,
        });
        print(cli, picked, () => (picked ? `候補: ${formatIssueLine(picked)}\n着手・予約はしていません。着手時は next または start で再確認します。` : "着手できる Issue はありません"));
      }),
    );

  issue
    .command("next")
    .description("着手できる Issue を1件取り、着手する")
    .option("--project <project>", "Project の中から取る")
    .action(
      actAsync(async (cli, cmd, o: { project?: string }) => {
        const picked = nextIssue(cli.ctx, {
          workspaceId: currentWorkspace(cli, cmd).id,
          projectRef: o.project,
          location: currentWorkLocation(),
        });
        if (picked) await notifyIfLlm(cli, { status: "in-progress", comment: `作業中: ${picked.id} ${picked.title}` });
        const rules = picked ? workspaceGuidance(cli.db, picked.workspace) : null;
        print(cli, picked && withRules(picked, rules), () =>
          picked ? withRulesText(`着手しました: ${formatIssueLine(picked)}`, rules) : "着手できる Issue はありません",
        );
      }),
    );

  issue
    .command("start <id>")
    .description("指定した Issue に着手する")
    .action(
      actAsync(async (cli, _cmd, id: string) => {
        const started = startIssue(cli.ctx, id, { location: currentWorkLocation() });
        await notifyIfLlm(cli, { status: "in-progress", comment: `作業中: ${started.id} ${started.title}` });
        const rules = workspaceGuidance(cli.db, started.workspace);
        // 差し戻しの対応依頼・追加指示（#51・#58）。LLM が受け取ると確認済みになる
        const pendingInstructions = takePendingInstructions(cli.ctx, started.id);
        // 再提出するまで、差し戻しの理由を start のたびに出す（#177）。対応依頼を渡す回は、その本文に理由があるので重ねない
        const rejection = getPendingRejection(cli.db, started.id);
        const delegated = rejection?.delegate && pendingInstructions.some((i) => i.kind === rejection.delegate);
        const text = [
          `着手しました: ${formatIssueLine(started)}`,
          ...(rejection && !delegated ? ["", ...formatRejection(rejection)] : []),
          ...(pendingInstructions.length ? ["", "追加指示（先に読んで対応する）:", ...formatInstructions(pendingInstructions)] : []),
        ].join("\n");
        print(cli, { ...withRules(started, rules), pendingInstructions, rejection }, () => withRulesText(text, rules));
      }),
    );

  issue
    .command("plan <id>")
    .description("計画を作る。実装計画書があれば --from で取り込む")
    .option("--from <path>", "writing-plans の実装計画書（### Task と - [ ] **Step** を取り込む）")
    .option("--step <title>", "Task のタイトル（繰り返し可、書いた順に並ぶ）", collect)
    .action(
      act((cli, _cmd, id: string, o: { from?: string; step?: string[] }) => {
        if (Boolean(o.from) === Boolean(o.step)) {
          throw new NodError("INVALID_ARGS", "--from か --step のどちらか一方を指定してください");
        }
        const plan = o.from ? importPlan(cli.ctx, id, o.from) : setPlanTasks(cli.ctx, id, o.step ?? []);
        print(cli, plan, () => [`計画を作りました（Task ${plan.tasks.length} 件）`, ...formatPlan(plan)].join("\n"));
      }),
    );

  issue
    .command("step <id> <ref> <status>")
    .description("Task（例: 2）か Step（例: 2.3）の状態を更新する（pending|doing|done|skipped）")
    .action(
      act((cli, _cmd, id: string, ref: string, status: string) => {
        const plan = setStep(cli.ctx, id, ref, parseStepStatus(status));
        print(cli, plan, () => `${ref} を ${status} にしました`);
      }),
    );

  issue
    .command("log <id> <text>")
    .description("作業ログを種類付きで残す（節目ごとに1件）")
    .option("--kind <kind>", `種類（${WORK_LOG_KINDS.join("|")}）。省略すると progress（経過）`)
    .action(
      act((cli, _cmd, id: string, text: string, o: { kind?: string }) => {
        const c = logWork(cli.ctx, id, text, { kind: o.kind });
        print(cli, c, () => `${c.logKind ? WORK_LOG_KIND_LABEL[c.logKind] : "経過"}を残しました`);
      }),
    );

  issue
    .command("ask <id> <question>")
    .description("確認を依頼する。作業中なら回答まで作業を止め、着手前なら Needs Clarification にする")
    .action(
      actAsync(async (cli, _cmd, id: string, question: string) => {
        const r = askQuestion(cli.ctx, id, question);
        // 入力待ちのカード表示は、LLM が作業を止めたときだけにする（私が未決事項を足しても変えない）
        if (isLlm(cli.ctx) && r.issue.agentState === "awaiting_input") {
          await notifyOrca({ comment: `入力待ち: ${question}` });
        }
        print(cli, r, () => askMessage(r, isLlm(cli.ctx)));
      }),
    );

  issue
    .command("fail <id> <reason>")
    .description("作業を続けられないことを報告する")
    .action(
      actAsync(async (cli, _cmd, id: string, reason: string) => {
        const failed = failIssue(cli.ctx, id, reason);
        await notifyIfLlm(cli, { comment: `エラー: ${reason}` });
        print(cli, failed, () => `失敗を報告しました: ${formatIssueLine(failed)}`);
      }),
    );

  issue
    .command("done <id>")
    .description("作業を終え、人のレビューに回す")
    .requiredOption("--summary <text>", "やったことの要約")
    .option("--pr <url>", "PR の URL")
    .action(
      actAsync(async (cli, _cmd, id: string, o: { summary: string; pr?: string }) => {
        const done = completeIssue(cli.ctx, id, { summary: o.summary, prUrl: o.pr });
        await notifyIfLlm(cli, { status: "in-review", comment: `レビュー待ち: ${done.id} ${done.title}` });
        print(cli, done, () => `レビューに回しました: ${formatIssueLine(done)}`);
      }),
    );

  const doc = issue.command("doc").description("Issue に Document を添付する");
  doc
    .command("add <id> <path>")
    .description("Markdown ファイルを添付する")
    .option("--title <text>", "タイトル（省略時は最初の # 見出し）")
    .option("--kind <kind>", "種類（spec|plan|doc）")
    .action(
      act((cli, _cmd, id: string, path: string, o: { title?: string; kind?: string }) => {
        const added = attachDocument(
          cli.ctx,
          { issueRef: id },
          { path, title: o.title, kind: o.kind === undefined ? undefined : parseDocKind(o.kind) },
        );
        print(cli, added, () => `添付しました: ${added.title}（${added.path}）`);
      }),
    );
  doc
    .command("remove <id> <path>")
    .description("添付を外す")
    .action(
      act((cli, _cmd, id: string, path: string) => {
        detachDocument(cli.ctx, { issueRef: id }, path);
        print(cli, { removed: path }, () => `添付を外しました: ${path}`);
      }),
    );

  const attach = issue
    .command("attach")
    .description("Issue にリンクやファイルを添付する（Markdown を nod で読むなら issue doc を使う）");
  attach
    .command("add <id>")
    .description("http/https のリンクか、ファイル（添付ディレクトリ NOD_ATTACHMENTS_DIR にコピーする）を添付する")
    .option("--url <url>", "添付するリンク（http:// か https://）")
    .option("--file <path>", "添付するファイル（10MB まで、録画の mp4/webm は 100MB まで。拡張子は png/jpg/gif/webp/mp4/webm/pdf/txt/log/md/csv/json/yaml/zip）")
    .option("--title <text>", "表示名（省略時はホスト名かファイル名）")
    .action(
      act((cli, _cmd, id: string, o: { url?: string; file?: string; title?: string }) => {
        if ((o.url === undefined) === (o.file === undefined)) {
          throw new NodError("INVALID_ARGS", "--url と --file のどちらか一方を指定してください");
        }
        const added =
          o.url !== undefined
            ? addLinkAttachment(cli.ctx, id, { url: o.url, title: o.title })
            : addFileAttachment(cli.ctx, id, { path: o.file as string, title: o.title });
        print(cli, added, () => `添付しました: ${formatAttachment(added)}`);
      }),
    );
  attach
    .command("list <id>")
    .description("添付を一覧する")
    .action(
      act((cli, _cmd, id: string) => {
        const list = listIssueAttachments(cli.db, id);
        print(cli, list, () => (list.length ? list.map(formatAttachment).join("\n") : "添付はありません"));
      }),
    );
  attach
    .command("remove <id> <attachmentId>")
    .description("添付を削除する（ファイルはコピーも消す）")
    .action(
      act((cli, _cmd, id: string, attachmentId: string) => {
        const removed = parsePositiveInt(attachmentId, "添付の id ");
        removeAttachment(cli.ctx, id, removed);
        print(cli, { removed }, () => `添付を削除しました: ${removed}`);
      }),
    );
}

function askMessage(r: AskResult, llm: boolean): string {
  if (!r.created) return "同じ確認依頼がすでにあります";
  if (r.issue.status === "needs_clarification") {
    return `未決事項を足しました。すべて回答されるまで ${r.issue.id} は ${statusText(r.issue.status, r.issue.id)} です`;
  }
  if (llm && r.issue.agentState === "awaiting_input") {
    return "確認を依頼しました。回答があるまで、この Issue の作業を止めてください";
  }
  return "確認依頼を足しました";
}

// LLM に守らせる作業規約と、ステータスの遷移ルール（#73）
interface WorkspaceGuidance {
  rules: WorkspaceRules | null;
  transitions: WorkspaceTransitionRules;
}

function workspaceGuidance(db: Database, workspaceKey: string): WorkspaceGuidance {
  return { rules: getWorkspaceRules(db, workspaceKey), transitions: getTransitionRules(db, workspaceKey) };
}

const hasTransitionRules = (t: WorkspaceTransitionRules) => t.forbidden.length > 0 || t.presets.length > 0;

// 作業規約・遷移ルールは設定済みのときだけ添える。未設定なら出力は従来と同じ
function withRules<T extends Issue>(
  issue: T,
  g: WorkspaceGuidance | null,
): T & { workspaceRules?: Omit<WorkspaceRules, "workspaceKey">; transitionRules?: Omit<WorkspaceTransitionRules, "workspaceKey"> } {
  if (!g) return issue;
  return {
    ...issue,
    ...(g.rules ? { workspaceRules: { body: g.rules.body, updatedAt: g.rules.updatedAt, updatedBy: g.rules.updatedBy } } : {}),
    ...(hasTransitionRules(g.transitions) ? { transitionRules: { forbidden: g.transitions.forbidden, presets: g.transitions.presets } } : {}),
  };
}

function withRulesText(text: string, g: WorkspaceGuidance | null): string {
  if (!g) return text;
  const sections = [g.rules ? formatWorkspaceRulesSection(g.rules) : "", formatTransitionRulesSection(g.transitions)].filter(Boolean);
  return sections.length ? `${text}\n\n${sections.join("\n")}`.trimEnd() : text;
}
