import { getTemplate, listTemplates, readDocumentFile, removeTemplate, saveTemplate } from "@nod/core";
import type { Command } from "commander";
import { act } from "../context";
import { print } from "../output";

export function registerTemplateCommands(program: Command): void {
  const template = program.command("template").description("Issue の説明の雛形（テンプレート）を管理する");

  template
    .command("add <name>")
    .description("テンプレートを登録する（同じ名前があれば本文を置き換える）")
    .requiredOption("--from <path>", "本文にする Markdown ファイル")
    .action(
      act((cli, _cmd, name: string, o: { from: string }) => {
        const r = saveTemplate(cli.ctx, { name, body: readDocumentFile(o.from).content });
        print(cli, r, () => `${r.created ? "登録しました" : "本文を置き換えました"}: ${r.template.name}`);
      }),
    );

  template
    .command("list")
    .description("テンプレートを一覧する")
    .action(
      act((cli) => {
        const list = listTemplates(cli.db);
        print(cli, list, () =>
          list.length ? list.map((t) => `${t.name}  （更新 ${t.updatedAt.slice(0, 10)}）`).join("\n") : "テンプレートはありません",
        );
      }),
    );

  template
    .command("show <name>")
    .description("テンプレートの本文を表示する")
    .action(
      act((cli, _cmd, name: string) => {
        const t = getTemplate(cli.db, name);
        print(cli, t, () => t.body);
      }),
    );

  template
    .command("remove <name>")
    .description("テンプレートを消す")
    .action(
      act((cli, _cmd, name: string) => {
        const t = removeTemplate(cli.ctx, name);
        print(cli, { removed: t.name }, () => `消しました: ${t.name}`);
      }),
    );
}
