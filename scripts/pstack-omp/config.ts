// 利用者の OMP の設定（<PI_CODING_AGENT_DIR>/config.yml、無ければ config.yaml）を読む（書かない）。状態の表示（status.ts）が、OMP が global の
// 設定として読むファイルの3つの読み込みの設定と、通常の omp が読むスキルの置き場（omp-skills.ts）を、このファイルの値で決める。
// 読むのは Bun の YAML。設定ファイルがシンボリックリンクなら、OMP と同じくリンクの先を読む。
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { PstackOmpError } from "./context";

export interface OmpConfig {
  // 設定ファイル（config.yml か config.yaml）のパス（リンクなら先）
  path: string;
  // 読んだ値（無い、空なら {}）
  data: Record<string, unknown>;
}

// OMP がいま global の設定として読むファイルのパス。OMP 19.1.0 と同じく config.yml を読み、無いときだけ config.yaml を読む
// （config.yml が在れば、空でも config.yaml は読まない）。どちらも無ければ config.yml。リンクを解き、置き場がまだ無くても、
// 在る祖先の別名（macOS の /var と /private/var など）を解いた形にする
export function globalConfigPath(agentDir: string): string {
  const yml = realAncestor(join(agentDir, "config.yml"));
  if (existsSync(yml)) return yml;
  const yaml = yamlConfigPath(agentDir);
  return existsSync(yaml) ? yaml : yml;
}

// config.yml が無いときに OMP が読む config.yaml のパス（globalConfigPath と同じく、在る祖先の別名を解いた形）
export function yamlConfigPath(agentDir: string): string {
  return realAncestor(join(agentDir, "config.yaml"));
}

// path のリンクと別名を解いた形。path がまだ無ければ、在る祖先まで解いて残りをつなぐ
export function realAncestor(path: string): string {
  for (let at = path, rest = ""; ; ) {
    try {
      return join(realpathSync(at), rest);
    } catch {
      if (dirname(at) === at) return path;
      rest = join(basename(at), rest);
      at = dirname(at);
    }
  }
}

// 読めなければ（YAML として不正、全体がマッピングでない）止める
export function readConfig(path: string): OmpConfig {
  if (!existsSync(path)) return { path, data: {} };
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new PstackOmpError(`OMP の設定 ${path} を YAML として読めません: ${(e as Error).message}。直してから、もう一度実行してください`);
  }
  if (parsed === null || parsed === undefined) return { path, data: {} };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PstackOmpError(`OMP の設定 ${path} の全体がマッピングではありません。直してから、もう一度実行してください`);
  }
  return { path, data: parsed as Record<string, unknown> };
}

// 設定の値（skills.customDirectories のような . 区切りの id）。途中がマッピングでなければ undefined
export function valueAt(data: Record<string, unknown>, id: string): unknown {
  let value: unknown = data;
  for (const key of id.split(".")) {
    value = isMapping(value) ? value[key] : undefined;
  }
  return value;
}

export function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 設定の値のうち文字列の配列のもの。文字列の配列でなければ止める。無ければ undefined
export function stringList(config: OmpConfig, id: string): string[] | undefined {
  const value = valueAt(config.data, id);
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) {
    throw new PstackOmpError(`OMP の設定 ${config.path} の ${id} が文字列の配列ではありません。直してから、もう一度実行してください`);
  }
  return value;
}
