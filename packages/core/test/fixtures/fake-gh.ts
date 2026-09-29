// createCommandRunner のテストで gh の代わりに起動するスクリプト。GitHub には触れない
const [mode, text] = process.argv.slice(2);
if (mode === "echo") {
  process.stdout.write(text ?? "");
  process.stderr.write("err");
  process.exit(3);
}
if (mode === "sleep") await Bun.sleep(30_000);
// SIGTERM を無視して居座る gh。pid を text のファイルに書く（SIGKILL で止められたかをテストが確かめる）
if (mode === "ignore-term") {
  process.on("SIGTERM", () => {});
  await Bun.write(text!, String(process.pid));
  process.stdout.write("partial");
  await Bun.sleep(30_000);
}
// 出力を書き続ける gh。text のファイルに pid を書き、SIGTERM は無視する（上限で止められたかをテストが確かめる）。
// 1文字3バイトの「あ」を書くので、文字数ではなくバイト数で数えているかも確かめられる
if (mode === "flood") {
  process.on("SIGTERM", () => {});
  await Bun.write(text!, String(process.pid));
  const chunk = "あ".repeat(1024);
  for (;;) {
    process.stdout.write(chunk);
    await Bun.sleep(1);
  }
}
export {};
