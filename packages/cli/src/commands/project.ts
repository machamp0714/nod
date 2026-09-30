import {
  addProjectUpdate,
  attachDocument,
  createProject,
  detachDocument,
  getProject,
  listProjects,
  listProjectUpdates,
  NodError,
  type ProjectUpdate,
  updateProject,
} from "@nod/core";
import type { Command } from "commander";
import { parseDocKind, parseProjectHealth, parseProjectStatus } from "../args";
import { act } from "../context";
import { formatIssueLines, print } from "../output";

function formatProjectUpdate(u: ProjectUpdate): string {
  const at = u.createdAt.slice(0, 16).replace("T", " ");
  return [`  ${at}  ${u.author}${u.health ? `（${u.health}）` : ""}:`, ...u.body.split("\n").map((line) => `    ${line}`)].join("\n");
}

export function registerProjectCommands(program: Command): void {
  const project = program.command("project").description("Project を操作する");

  project
    .command("list")
    .description("Project を進捗と LLM の状況つきで一覧する")
    .option("--all", "completed と canceled の Project も含める")
    .action(
      act((cli, _cmd, o: { all?: boolean }) => {
        const list = listProjects(cli.db, { includeClosed: Boolean(o.all) });
        print(cli, list, () =>
          list.length
            ? list
                .map(
                  (p) =>
                    `${p.id}  ${p.name}  ${p.done}/${p.total}  健全性 ${p.health ?? "未設定"}  作業中 ${p.agents.working}、入力待ち ${p.agents.awaitingInput}、レビュー待ち ${p.agents.awaitingReview}、エラー ${p.agents.error}`,
                )
                .join("\n")
            : "Project はありません",
        );
      }),
    );

  project
    .command("create <name>")
    .description("Project を作る")
    .option("-d, --description <text>", "説明")
    .action(
      act((cli, _cmd, name: string, o: { description?: string }) => {
        const created = createProject(cli.ctx, { name, description: o.description });
        print(cli, created, () => `作りました: ${created.id}  ${created.name}`);
      }),
    );

  project
    .command("show <project>")
    .description("Project の Issue、Documents、最新の進捗報告を表示する")
    .action(
      act((cli, _cmd, ref: string) => {
        const p = getProject(cli.db, ref);
        print(cli, p, () =>
          [
            `${p.id}  ${p.name}（${p.status}）  ${p.done}/${p.total}  健全性 ${p.health ?? "未設定"}`,
            ...(p.description ? ["", p.description] : []),
            "",
            "Issue:",
            ...formatIssueLines(p.issues).map((line) => `  ${line}`),
            ...(p.documents.length ? ["", "Documents:", ...p.documents.map((d) => `  - ${d.title}（${d.kind}）${d.path}`)] : []),
            ...(p.updates[0]
              ? ["", `最新の進捗報告（全 ${p.updates.length} 件は nod project report list）:`, formatProjectUpdate(p.updates[0])]
              : []),
          ].join("\n"),
        );
      }),
    );

  project
    .command("update <project>")
    .description("Project のステータスを変更する")
    .option("--status <status>", "planned|started|completed|canceled")
    .action(
      act((cli, _cmd, ref: string, o: { status?: string }) => {
        if (o.status === undefined) throw new NodError("INVALID_ARGS", "--status を指定してください");
        const updated = updateProject(cli.ctx, ref, { status: parseProjectStatus(o.status) });
        print(cli, updated, () => `更新しました: ${updated.id}  ${updated.name}（${updated.status}）`);
      }),
    );

  const report = project.command("report").description("Project の進捗報告を書く・読む");
  report
    .command("add <project> <body>")
    .description("進捗報告を書く（書き手と日時を記録する。Issue や Project の状態は変えない）")
    .option("--health <health>", "健全性を添える（on_track|at_risk|off_track）。添えた値が Project の現在の健全性になる")
    .action(
      act((cli, _cmd, ref: string, body: string, o: { health?: string }) => {
        const health = o.health === undefined ? null : parseProjectHealth(o.health);
        const added = addProjectUpdate(cli.ctx, ref, body, health);
        print(cli, added, () => `進捗報告を書きました: ${added.id}`);
      }),
    );
  report
    .command("list <project>")
    .description("進捗報告を新しい順に表示する")
    .action(
      act((cli, _cmd, ref: string) => {
        const list = listProjectUpdates(cli.db, ref);
        print(cli, list, () => (list.length ? list.map(formatProjectUpdate).join("\n\n") : "進捗報告はありません"));
      }),
    );

  const doc = project.command("doc").description("Project に Document を添付する");
  doc
    .command("add <project> <path>")
    .description("Markdown ファイルを添付する")
    .option("--title <text>", "タイトル（省略時は最初の # 見出し）")
    .option("--kind <kind>", "種類（spec|plan|doc）")
    .action(
      act((cli, _cmd, ref: string, path: string, o: { title?: string; kind?: string }) => {
        const added = attachDocument(
          cli.ctx,
          { projectRef: ref },
          { path, title: o.title, kind: o.kind === undefined ? undefined : parseDocKind(o.kind) },
        );
        print(cli, added, () => `添付しました: ${added.title}（${added.path}）`);
      }),
    );
  doc
    .command("remove <project> <path>")
    .description("添付を外す")
    .action(
      act((cli, _cmd, ref: string, path: string) => {
        detachDocument(cli.ctx, { projectRef: ref }, path);
        print(cli, { removed: path }, () => `添付を外しました: ${path}`);
      }),
    );
}
