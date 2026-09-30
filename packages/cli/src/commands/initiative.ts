import {
  addInitiativeProject,
  createInitiative,
  getInitiative,
  type InitiativeSummary,
  listInitiatives,
  NodError,
  removeInitiativeProject,
  type UpdateInitiativeInput,
  updateInitiative,
} from "@nod/core";
import type { Command } from "commander";
import { parseProjectStatus } from "../args";
import { act } from "../context";
import { print } from "../output";

function formatInitiative(i: InitiativeSummary): string {
  const target = i.targetDate ? `  目標日 ${i.targetDate}` : "";
  return `${i.id}  ${i.name}（${i.status}）  ${i.done}/${i.total}  Project ${i.projectCount}${target}`;
}

export function registerInitiativeCommands(program: Command): void {
  const initiative = program.command("initiative").description("複数の Project を束ねる上位目標（Initiative）を操作する");

  initiative
    .command("list")
    .description("Initiative を配下 Project の合算進捗つきで一覧する")
    .option("--all", "completed と canceled の Initiative も含める")
    .action(
      act((cli, _cmd, o: { all?: boolean }) => {
        const list = listInitiatives(cli.db, { includeClosed: Boolean(o.all) });
        print(cli, list, () => (list.length ? list.map(formatInitiative).join("\n") : "Initiative はありません"));
      }),
    );

  initiative
    .command("create <name>")
    .description("Initiative を作る")
    .option("-d, --description <text>", "説明")
    .option("--target <date>", "目標日（YYYY-MM-DD）")
    .action(
      act((cli, _cmd, name: string, o: { description?: string; target?: string }) => {
        const created = createInitiative(cli.ctx, { name, description: o.description, targetDate: o.target });
        print(cli, created, () => `作りました: ${created.id}  ${created.name}`);
      }),
    );

  initiative
    .command("show <initiative>")
    .description("Initiative と配下 Project の進捗を表示する")
    .action(
      act((cli, _cmd, ref: string) => {
        const i = getInitiative(cli.db, ref);
        print(cli, i, () =>
          [
            formatInitiative(i),
            ...(i.description ? ["", i.description] : []),
            "",
            "Project:",
            ...(i.projects.length ? i.projects.map((p) => `  ${p.id}  ${p.name}（${p.status}）  ${p.done}/${p.total}`) : ["  （なし）"]),
          ].join("\n"),
        );
      }),
    );

  initiative
    .command("update <initiative>")
    .description("Initiative の名前・説明・目標日・状態を変える（配下 Project と Issue は変えない）")
    .option("--name <name>", "名前")
    .option("-d, --description <text>", "説明（空文字で外す）")
    .option("--target <date>", "目標日 YYYY-MM-DD（空文字で外す）")
    .option("--status <status>", "planned|started|completed|canceled")
    .action(
      act((cli, _cmd, ref: string, o: { name?: string; description?: string; target?: string; status?: string }) => {
        const input: UpdateInitiativeInput = {
          name: o.name,
          description: o.description === undefined ? undefined : o.description || null,
          targetDate: o.target === undefined ? undefined : o.target || null,
          status: o.status === undefined ? undefined : parseProjectStatus(o.status),
        };
        if (Object.values(input).every((v) => v === undefined)) {
          throw new NodError("INVALID_ARGS", "--name、-d、--target、--status のどれかを指定してください");
        }
        const updated = updateInitiative(cli.ctx, ref, input);
        print(cli, updated, () => `更新しました: ${updated.id}  ${updated.name}（${updated.status}）`);
      }),
    );

  initiative
    .command("add-project <initiative> <project>")
    .description("Project を Initiative に紐付ける（1つの Project を複数の Initiative に紐付けられる）")
    .action(
      act((cli, _cmd, ref: string, projectRef: string) => {
        const updated = addInitiativeProject(cli.ctx, ref, projectRef);
        print(cli, updated, () => `紐付けました: ${updated.name}（Project ${updated.projectCount}）`);
      }),
    );

  initiative
    .command("remove-project <initiative> <project>")
    .description("Project の紐付けを外す（Project と Issue は残る）")
    .action(
      act((cli, _cmd, ref: string, projectRef: string) => {
        const updated = removeInitiativeProject(cli.ctx, ref, projectRef);
        print(cli, updated, () => `紐付けを外しました: ${updated.name}（Project ${updated.projectCount}）`);
      }),
    );
}
