import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import s from "./markdown.module.css";

// ページの見出し（<h1>）と重ならないよう、本文の見出しを1段下げる。
// react-markdown は部品に node を渡すため、DOM の属性にしないよう取り除く。
const components: Components = {
  h1: ({ node: _node, ...props }) => <h2 {...props} />,
  h2: ({ node: _node, ...props }) => <h3 {...props} />,
  h3: ({ node: _node, ...props }) => <h4 {...props} />,
  h4: ({ node: _node, ...props }) => <h5 {...props} />,
  h5: ({ node: _node, ...props }) => <h6 {...props} />,
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
};

// 生の HTML は描画しない（rehype-raw を使わない）。LLM が書いた説明をそのまま表示するためである。
export function Markdown({ children }: { children: string }) {
  return (
    <div className={s.markdown}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
