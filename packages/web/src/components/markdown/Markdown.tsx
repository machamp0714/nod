import { createContext, useContext } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { documentAssetSrc } from "../../lib/document";
import s from "./markdown.module.css";

// チェックボックスを押したときに呼ぶ。offset はその項目（li）の Markdown 上の開始位置
export type TaskToggle = (offset: number, checked: boolean) => void;

const TaskToggleContext = createContext<{ onToggle: TaskToggle; disabled: boolean } | null>(null);
// チェックボックスが属する項目の開始位置。項目の間に空行があるとチェックボックスは p の中に入るため、li から渡す
const TaskOffsetContext = createContext<number | null>(null);

// Document の本文を描くときだけ、その id を渡す。null（既定）なら画像の src を書き換えない（Issue の説明など）
export const DocumentAssetContext = createContext<number | null>(null);

function DocumentImage({ src, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) {
  const documentId = useContext(DocumentAssetContext);
  const resolved = documentId !== null && typeof src === "string" ? documentAssetSrc(documentId, src) : src;
  return <img {...props} src={resolved} />;
}

// ページの見出し（<h1>）と重ならないよう、本文の見出しを1段下げる。
// react-markdown は部品に node を渡すため、DOM の属性にしないよう取り除く。
const components: Components = {
  h1: ({ node: _node, ...props }) => <h2 {...props} />,
  h2: ({ node: _node, ...props }) => <h3 {...props} />,
  h3: ({ node: _node, ...props }) => <h4 {...props} />,
  h4: ({ node: _node, ...props }) => <h5 {...props} />,
  h5: ({ node: _node, ...props }) => <h6 {...props} />,
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
  li: ({ node, ...props }) => (
    <TaskOffsetContext.Provider value={node?.position?.start.offset ?? null}>
      <li {...props} />
    </TaskOffsetContext.Provider>
  ),
  input: ({ node: _node, ...props }) => <TaskCheckbox {...props} />,
  img: ({ node: _node, ...props }) => <DocumentImage {...props} />,
};

function TaskCheckbox(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const toggle = useContext(TaskToggleContext);
  const offset = useContext(TaskOffsetContext);
  if (props.type !== "checkbox" || !toggle || offset === null) return <input {...props} />;
  return (
    <input
      {...props}
      disabled={toggle.disabled}
      onChange={(e) => toggle.onToggle(offset, e.target.checked)}
    />
  );
}

const GFM = [remarkGfm];
const GFM_WITH_BREAKS = [remarkGfm, remarkBreaks];

// 生の HTML は描画しない（rehype-raw を使わない）。LLM が書いた説明をそのまま表示するためである。
// breaks を付けると、改行1つを改行のまま出す（Issue の説明。行を改行だけで区切って書かれるため。#176）。
// 付けないと Markdown の規則どおり1段落につなぐ（Document。折り返して書かれた Markdown ファイルのため）。
// onToggleTask を渡すと、タスクリストのチェックボックスを押せるようにする
export function Markdown({
  children,
  breaks = false,
  onToggleTask,
  taskDisabled = false,
}: {
  children: string;
  breaks?: boolean;
  onToggleTask?: TaskToggle;
  taskDisabled?: boolean;
}) {
  const body = (
    <ReactMarkdown remarkPlugins={breaks ? GFM_WITH_BREAKS : GFM} components={components}>
      {children}
    </ReactMarkdown>
  );
  return (
    <div className={s.markdown}>
      {onToggleTask ? (
        <TaskToggleContext.Provider value={{ onToggle: onToggleTask, disabled: taskDisabled }}>{body}</TaskToggleContext.Provider>
      ) : (
        body
      )}
    </div>
  );
}
