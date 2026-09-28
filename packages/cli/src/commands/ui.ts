import type { Command } from "commander";
import { openBrowser } from "../browser";
import { parsePort } from "../args";
import { globalOpts } from "../context";
import { print } from "../output";
import { defaultWebDir, startUi } from "../ui";

export function registerUiCommand(program: Command): void {
  program
    .command("ui")
    .description("server を起動し、ブラウザで Web UI を開く（Ctrl+C で止める）")
    .option("--port <port>", "待ち受けるポート（既定: 4700。0 なら空いているポート）")
    .option("--web-dir <dir>", "ビルド済みの web のディレクトリ（既定: リポジトリの packages/web/dist）")
    .option("--no-open", "ブラウザを開かない")
    // server が自分で DB を開くため、act で包まない
    .action(async (o: { port?: string; webDir?: string; open: boolean }, cmd: Command) => {
      const out = globalOpts(cmd);
      const controller = new AbortController();
      const stop = () => controller.abort();
      const stopped = new Promise<void>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      try {
        const ui = await startUi({
          port: o.port === undefined ? undefined : parsePort(o.port),
          webDir: o.webDir ?? defaultWebDir(),
          open: o.open,
        }, { openBrowser: (url) => openBrowser(url, controller.signal) });
        const { server, ...info } = ui;
        print(out, info, () =>
          ui.reused
            ? `すでに起動している nod ui を開きます: ${ui.url}`
            : `nod ui: ${ui.url}（DB: ${ui.dbPath}）\n止めるには Ctrl+C を押してください`,
        );
        if (o.open && !ui.opened && !controller.signal.aborted) console.error(`ブラウザを開けませんでした。${ui.url} を開いてください`);
        if (!server) return;
        await stopped;
        await server.stop();
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    });
}
