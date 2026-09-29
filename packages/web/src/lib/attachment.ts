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

// 画面に埋め込んで表示する添付の種類。server の inline 配信と同じく svg は含めない
const MEDIA: Readonly<Record<string, "image" | "video">> = {
  "image/png": "image", "image/jpeg": "image", "image/gif": "image", "image/webp": "image",
  "video/mp4": "video", "video/webm": "video",
};

export function mediaKind(a: IssueAttachment): "image" | "video" | null {
  return a.kind === "file" && a.mime && Object.hasOwn(MEDIA, a.mime) ? MEDIA[a.mime] : null;
}

export function mediaAttachments(list: IssueAttachment[]): IssueAttachment[] {
  return list.filter(a => mediaKind(a) !== null);
}

// 画像・動画を埋め込むときの配信先（Content-Disposition: inline、Range 対応）
export function attachmentViewPath(id: number): string {
  return `/api/attachments/${id}/view`;
}

export function videoBadge(a: IssueAttachment): string {
  return (a.fileName?.split(".").pop() ?? "").toUpperCase();
}
