import { describe, expect, test } from "bun:test";
import {
  describeFilter,
  filterFromSearch,
  filterToSearch,
  issueQueryToParams,
  sameFilter,
  toggleValue,
  withoutKey,
} from "./issue-filter";

describe("filterFromSearch と filterToSearch", () => {
  test("search params から絞り込み条件のキーだけを取り出す", () => {
    expect(
      filterFromSearch({ tab: "ready", q: "api", workspace: ["API"], status: ["todo"], project: "3", label: [] }),
    ).toEqual({ workspace: ["API"], status: ["todo"], project: "3" });
  });

  test("条件にないキーは undefined にして、URL から消せるようにする", () => {
    expect(filterToSearch({ label: ["bug"] })).toEqual({
      workspace: undefined,
      status: undefined,
      project: undefined,
      label: ["bug"],
    });
  });
});

describe("issueQueryToParams", () => {
  test("配列は同じキーを繰り返し、ready は true のときだけ付ける", () => {
    expect(
      issueQueryToParams({ workspace: ["API", "NOD"], status: ["todo"], project: "3", label: ["bug", "a b"], ready: true }),
    ).toBe("?workspace=API&workspace=NOD&status=todo&project=3&label=bug&label=a+b&ready=true");
    expect(issueQueryToParams({ ready: false })).toBe("");
    expect(issueQueryToParams({})).toBe("");
  });
});

describe("sameFilter", () => {
  test("配列の順は問わず、空の配列と省略を同じとみなす", () => {
    expect(sameFilter({ workspace: ["NOD", "API"] }, { workspace: ["API", "NOD"] })).toBe(true);
    expect(sameFilter({ label: [] }, {})).toBe(true);
    expect(sameFilter({ status: ["todo"] }, {})).toBe(false);
    expect(sameFilter({ project: "1" }, { project: "2" })).toBe(false);
    expect(sameFilter({ ready: true }, {})).toBe(false);
  });
});

test("ルーターが残した未検証の search params を API に渡さない", () => {
  expect(filterFromSearch({ status: ["wip"], project: "abc" } as never)).toEqual({});
  expect(filterFromSearch({ workspace: ["blog"] })).toEqual({ workspace: ["BLOG"] });
});

describe("describeFilter", () => {
  test("条件ごとに、名前と表示用の値を並べる", () => {
    const labelOf = {
      workspace: (key: string) => key.toLowerCase(),
      project: (ref: string) => `P${ref}`,
      status: (status: string) => status.toUpperCase(),
    };
    expect(
      describeFilter({ workspace: ["API", "NOD"], status: ["todo"], project: "3", label: ["bug"], ready: true }, labelOf),
    ).toEqual([
      { key: "workspace", name: "Workspace", values: "api, nod" },
      { key: "status", name: "Status", values: "TODO" },
      { key: "project", name: "Project", values: "P3" },
      { key: "label", name: "Label", values: "bug" },
      { key: "ready", name: "Ready", values: "のみ" },
    ]);
    expect(describeFilter({}, labelOf)).toEqual([]);
  });
});

describe("withoutKey と toggleValue", () => {
  test("条件を1つ外す", () => {
    expect(withoutKey({ workspace: ["API"], label: ["bug"] }, "label")).toEqual({ workspace: ["API"] });
  });

  test("値を足し引きし、空になったら undefined にする", () => {
    expect(toggleValue(["API"], "NOD")).toEqual(["API", "NOD"]);
    expect(toggleValue(["API", "NOD"], "API")).toEqual(["NOD"]);
    expect(toggleValue(["API"], "API")).toBeUndefined();
    expect(toggleValue(undefined, "API")).toEqual(["API"]);
  });
});


test("一覧の表示設定を保存Viewのfilterへ混入しない", () => {
  expect(filterFromSearch({ sort: "updatedAt", direction: "desc", columns: [], workspace: ["API"], blocked: false })).toEqual({ workspace: ["API"], blocked: false });
});
