import type { IssueAttachment } from "../api/types";
import { attachmentDate } from "../components/issue-detail/DocumentsSection";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// 描画する href。server も http/https に限っているが、表示側でも javascript: などを開かせない
export function safeLinkHref(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// nod.pen「Issue詳細｜添付」。タイトルがなければリンクはホスト名、ファイルはファイル名
export function attachmentTitle(a: IssueAttachment): string {
  return a.title ?? (a.kind === "link" ? hostOf(a.url) ?? "" : a.fileName ?? "");
}

// メタ行。リンクはホスト名（題がホスト名なら省く）、ファイルはサイズ、続けて添付者と添付日
export function attachmentMeta(a: IssueAttachment): string {
  const lead = a.kind === "file" ? formatBytes(a.size ?? 0) : a.title ? hostOf(a.url) : null;
  return [lead, a.createdBy, attachmentDate(a.createdAt)].filter(Boolean).join(" · ");
}

export function attachmentDownloadPath(id: number): string {
  return `/api/attachments/${id}/download`;
}
