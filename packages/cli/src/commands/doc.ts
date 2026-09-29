import { readFileSync } from "node:fs";
import {
  createDocument,
  type DocTarget,
  getDocument,
  linkDocumentById,
  listDocuments,
  NodError,
  unlinkDocumentById,
} from "@nod/core";
import type { Command } from "commander";
import { parseDocKind } from "../args";
import { act } from "../context";
import { print } from "../output";

function parseDocId(value: string): number {
  if (!/^\d+$/.test(value)) throw new NodError("INVALID_ARGS", `${value} は Document の id ではありません（nod doc list で確かめられます）`);
  return Number(value);
}

function targetOf(o: { issue?: string; project?: string }): DocTarget {
  return { issueRef: o.issue, projectRef: o.project };
}

function linksText(issues: string[], projects: { name: string }[]): string {
  const all = [...issues, ...projects.map((p) => `Project ${p.name}`)];
  return all.length ? all.join(", ") : "リンクなし";
}

export function registerDocCommands(program: Command): void {
  const doc = program.command("doc").description("Document（Markdown ファイルへの参照）を作り、Issue や Project とリンクする");

  doc
    .command("create <path>")
    .description("Documents ディレクトリ（NOD_DOCS_DIR、既定は ~/.local/share/nod/documents）に Markdown を新しく作って登録する")
    .option("--title <text>", "タイトル。ファイルの最初の # 見出しになる（省略時はファイル名）")
    .option("--kind <kind>", "種類（spec|plan|doc。既定は doc）")
    .option("--body <text>", "見出しの後に置く本文。- なら標準入力から読む")
    .option("--issue <id>", "リンクする Issue")
    .option("--project <project>", "リンクする Project")
    .action(
      act((cli, _cmd, path: string, o: { title?: string; kind?: string; body?: string; issue?: string; project?: string }) => {
        if (o.issue && o.project) throw new NodError("INVALID_ARGS", "--issue と --project はどちらか一方を指定してください");
        const created = createDocument(cli.ctx, {
          path,
          title: o.title,
          kind: o.kind === undefined ? undefined : parseDocKind(o.kind),
          body: o.body === "-" ? readFileSync(0, "utf8") : o.body,
          ...targetOf(o),
        });
        print(cli, created, () => `作りました: ${created.id}  ${created.title}（${created.path}）`);
      }),
    );

  doc
    .command("list")
    .description("登録済みの Document を新しい順に一覧する")
    .action(
      act((cli) => {
        const list = listDocuments(cli.db);
        print(cli, list, () =>
          list.length
            ? list.map((d) => `${d.id}  ${d.title}（${d.kind}）  ${linksText(d.issues, d.projects)}  ${d.path}`).join("\n")
            : "Document はありません",
        );
      }),
    );

  doc
    .command("show <id>")
    .description("Document の本文とリンク先を表示する")
    .action(
      act((cli, _cmd, id: string) => {
        const d = getDocument(cli.db, parseDocId(id));
        print(cli, d, () =>
          [
            `${d.id}  ${d.title}（${d.kind}）`,
            d.path,
            `Issues: ${d.issues.length ? d.issues.map((i) => `${i.id} ${i.title}（${i.status}）`).join(", ") : "なし"}`,
            `Projects: ${d.projects.length ? d.projects.map((p) => p.name).join(", ") : "なし"}`,
            "",
            d.content ?? "ファイルが見つかりません",
          ].join("\n"),
        );
      }),
    );

  doc
    .command("link <id>")
    .description("Document を Issue か Project にリンクする")
    .option("--issue <id>", "リンクする Issue")
    .option("--project <project>", "リンクする Project")
    .action(
      act((cli, _cmd, id: string, o: { issue?: string; project?: string }) => {
        const linked = linkDocumentById(cli.ctx, parseDocId(id), targetOf(o));
        print(cli, linked, () => `リンクしました: ${linked.title} → ${o.issue ?? `Project ${o.project}`}`);
      }),
    );

  doc
    .command("unlink <id>")
    .description("Document と Issue か Project のリンクを外す")
    .option("--issue <id>", "リンクを外す Issue")
    .option("--project <project>", "リンクを外す Project")
    .action(
      act((cli, _cmd, id: string, o: { issue?: string; project?: string }) => {
        const docId = parseDocId(id);
        unlinkDocumentById(cli.ctx, docId, targetOf(o));
        print(cli, { unlinked: docId, ...targetOf(o) }, () => `リンクを外しました: ${docId} ↛ ${o.issue ?? `Project ${o.project}`}`);
      }),
    );
}
