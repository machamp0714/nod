import {
  type AskResult,
  diagnoseIssues,
  validateStaleDays,
  askQuestion,
  archiveIssue,
  attachDocument,
  commentIssue,
  resolveThread,
  completeIssue,
  copyIssue,
  createIssue,
  detachDocument,
  failIssue,
  formatWorkspaceRulesSection,
  getIssue,
  getIssueBranchName,
  getWorkspaceRules,
  importPlan,
  type Issue,
  isLlm,
  listIssues,
  NodError,
  nextIssue,
  suggestIssue,
  relateIssue,
  setPlanTasks,
  setStep,
  startIssue,
  unarchiveIssue,
  updateIssue,
  subscribeIssue,
  unsubscribeIssue,
  type WorkspaceRules,
  logWork,
  WORK_LOG_KIND_LABEL,
  WORK_LOG_KINDS,
} from "@nod/core";
import type { Command } from "commander";
import { collect, orNull, parseDocKind, parseEstimate, parsePositiveInt, parsePriority, parseStatus, parseStatuses, parseStepStatus } from "../args";
import { act, actAsync, type Cli, currentWorkspace, globalOpts } from "../context";
import { currentWorkLocation, notifyOrca, type OrcaUpdate } from "../orca";
import { formatDelegations, formatIssueDetail, formatIssueLine, formatIssueLines, formatPlan, print, sortByAssignee, statusColumnWidth, statusText } from "../output";

// Orca のカードは LLM 向けのコマンドで LLM が操作したときだけ更新する
async function notifyIfLlm(cli: Cli, update: OrcaUpdate): Promise<void> {
  if (isLlm(cli.ctx)) await notifyOrca(update);
}

export function registerIssueCommands(program: Command): void {
  const issue = program.command("issue").description("Issue を操作する");

  issue
    .command("create <title>")
    .description("Issue を起票する（LLM の起票は Triage に入る）")
    .option("-d, --description <text>", "説明")
    .option("--template <name>", "テンプレートの本文を説明の初期値にする（-d とは同時に使えない）")
    .option("--project <project>", "Project の名前か ID")
    .option("--parent <id>", "親 Issue（Sub-issue として作る）")
    .option("--discovered-from <id>", "発見元の Issue")
    .option("-p, --priority <0-4>", "優先度（0 = なし、1 = Urgent、2 = High、3 = Medium、4 = Low）")
    .option("--estimate <1-100>", "見積もり（ポイント）")
    .option("--due <YYYY-MM-DD>", "期限（日付。1900-01-01 以降）")
    .option("-l, --label <label>", "ラベル（繰り返し可）", collect)
    .action(
      act(
        (
          cli,
          cmd,
          title: string,
          o: { template?: string; description?: string; project?: string; parent?: string; discoveredFrom?: string; priority?: string; estimate?: string; due?: string; label?: string[] },
        ) => {
          const created = createIssue(cli.ctx, {
            workspaceId: currentWorkspace(cli, cmd).id,
            title,
            description: o.description,
            template: o.template,
            projectRef: o.project,
            parentRef: o.parent,
            discoveredFromRef: o.discoveredFrom,
            priority: o.priority === undefined ? undefined : parsePriority(o.priority),
            estimate: o.estimate === undefined ? undefined : parseEstimate(o.estimate),
            dueDate: o.due,
            labels: o.label,
          });
          print(cli, created, () => `起票しました: ${formatIssueLine(created)}`);
        },
      ),
    );

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
    .command("list")
    .description("Issue を一覧する（既定では done と canceled を除く）")
    .option("-s, --status <statuses>", "ステータス（カンマ区切り）")
    .option("--project <project>", "Project の名前か ID")
    .option("-l, --label <label>", "ラベル（繰り返し可、すべてを満たすもの）", collect)
    .option("--query <text>", "ID・タイトル・説明で検索")
    .option("--all-workspaces", "すべての Workspace の Issue を出す")
    .option("--completion-candidates", "Sub-issue がすべて完了した親（完了候補）だけを出す")
    .option("--archived", "アーカイブ済みの Issue だけを出す（--status を省くとすべてのステータス）")
    .option("--delegated", "LLM に委任中（担当が LLM で done/canceled 以外）の Issue を LLM ごとに出す（既定ですべての Workspace、-w で絞る）")
    .action(
      act(
        (
          cli,
          cmd,
          o: { status?: string; project?: string; label?: string[]; allWorkspaces?: boolean; query?: string; delegated?: boolean; completionCandidates?: boolean; archived?: boolean },
        ) => {
          // 委任中の一覧は人がどこからでも見られるよう、-w がなければ Workspace で絞らない
          const allWorkspaces = o.allWorkspaces || (o.delegated && !globalOpts(cmd).workspace);
          const issues = listIssues(cli.db, {
            query: o.query,
            workspaceId: allWorkspaces ? undefined : currentWorkspace(cli, cmd).id,
            statuses: o.status ? parseStatuses(o.status) : undefined,
            projectRef: o.project,
            labels: o.label,
            delegated: o.delegated,
            completionCandidate: o.completionCandidates,
            archived: o.archived,
          });
          if (o.delegated) {
            const sorted = sortByAssignee(issues);
            print(cli, sorted, () => formatDelegations(sorted));
            return;
          }
          print(cli, issues, () => (issues.length ? formatIssueLines(issues).join("\n") : "Issue はありません"));
        },
      ),
    );

  issue
    .command("show <id>")
    .description("Issue の詳細（計画、Documents、Activity を含む）を表示する")
    .action(
      act((cli, _cmd, id: string) => {
        const detail = getIssue(cli.db, id);
        const rules = getWorkspaceRules(cli.db, detail.workspace);
        print(cli, withRules(detail, rules), () => withRulesText(formatIssueDetail(detail), rules));
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

  issue
    .command("update <id>")
    .description("Issue のプロパティを変える（空文字を渡すと外す）")
    .option("--title <text>", "タイトル")
    .option("-d, --description <text>", "説明")
    .option("-p, --priority <0-4>", "優先度")
    .option("--estimate <1-100>", "見積もり（ポイント）")
    .option("--due <YYYY-MM-DD>", "期限（日付。1900-01-01 以降）")
    .option("-s, --status <status>", "ステータス")
    .option("--assignee <name>", "担当")
    .option("--parent <id>", "親 Issue")
    .option("--project <project>", "Project の名前か ID")
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
            title?: string;
            description?: string;
            priority?: string;
            estimate?: string;
            due?: string;
            status?: string;
            assignee?: string;
            parent?: string;
            project?: string;
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
            addLabels: o.addLabel,
            removeLabels: o.removeLabel,
            reason: o.reason,
          });
          print(cli, updated, () => `更新しました: ${formatIssueLine(updated)}`);
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
        const rules = picked ? getWorkspaceRules(cli.db, picked.workspace) : null;
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
        const rules = getWorkspaceRules(cli.db, started.workspace);
        print(cli, withRules(started, rules), () => withRulesText(`着手しました: ${formatIssueLine(started)}`, rules));
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

// 作業規約は登録済みのときだけ添える。未登録なら出力は従来と同じ
function withRules<T extends Issue>(issue: T, rules: WorkspaceRules | null): T | (T & { workspaceRules: Omit<WorkspaceRules, "workspaceKey"> }) {
  if (!rules) return issue;
  return { ...issue, workspaceRules: { body: rules.body, updatedAt: rules.updatedAt, updatedBy: rules.updatedBy } };
}

function withRulesText(text: string, rules: WorkspaceRules | null): string {
  return rules ? `${text}\n\n${formatWorkspaceRulesSection(rules)}`.trimEnd() : text;
}
