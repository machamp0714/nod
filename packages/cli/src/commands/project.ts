import { attachDocument, createProject, detachDocument, getProject, listProjects, NodError, updateProject } from "@nod/core";
import type { Command } from "commander";
import { parseDocKind, parseProjectStatus } from "../args";
import { act } from "../context";
import { formatIssueLine, print } from "../output";

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
                    `${p.id}  ${p.name}  ${p.done}/${p.total}  作業中 ${p.agents.working}、入力待ち ${p.agents.awaitingInput}、レビュー待ち ${p.agents.awaitingReview}、エラー ${p.agents.error}`,
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
    .description("Project の Issue と Documents を表示する")
    .action(
      act((cli, _cmd, ref: string) => {
        const p = getProject(cli.db, ref);
        print(cli, p, () =>
          [
            `${p.id}  ${p.name}（${p.status}）  ${p.done}/${p.total}`,
            ...(p.description ? ["", p.description] : []),
            "",
            "Issue:",
            ...p.issues.map((i) => `  ${formatIssueLine(i)}`),
            ...(p.documents.length ? ["", "Documents:", ...p.documents.map((d) => `  - ${d.title}（${d.kind}）${d.path}`)] : []),
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
