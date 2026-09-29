import { gcAttachments } from "@nod/core";
import type { Command } from "commander";
import { act } from "../context";
import { print } from "../output";

export function registerAttachmentsCommands(program: Command): void {
  const attachments = program.command("attachments").description("添付ファイルの保存先（NOD_ATTACHMENTS_DIR）を管理する");
  attachments
    .command("gc")
    .description("どの Issue からも参照されない添付ファイルのディレクトリを消す（作ってから1分以内のものは残す）")
    .option("--dry-run", "消さずに、消す対象だけを表示する")
    .action(
      act((cli, _cmd, o: { dryRun?: boolean }) => {
        const r = gcAttachments(cli.db, { dryRun: o.dryRun });
        print(cli, r, () => {
          if (r.removed.length === 0) return `消すものはありません（${r.dir}）`;
          const head = r.dryRun ? `消す対象: ${r.removed.length} 件（--dry-run のため消していません）` : `${r.removed.length} 件を消しました`;
          return [head, ...r.removed.map((name) => `  ${name}`)].join("\n");
        });
      }),
    );
}
