import { describe, expect, test } from "bun:test";
import { ApiError } from "./client";
import { errorMessage, isNotFoundError, shouldRetry } from "./errors";

describe("isNotFoundError", () => {
  test("404 と、ID の形が違う INVALID_ARGS を見つからないものとする", () => {
    expect(isNotFoundError(new ApiError(404, "NOT_FOUND", "ありません"))).toBe(true);
    expect(isNotFoundError(new ApiError(400, "INVALID_ARGS", "形が違います"))).toBe(true);
    expect(isNotFoundError(new ApiError(409, "NO_OPEN_QUESTION", "回答済み"))).toBe(false);
    expect(isNotFoundError(new TypeError("Failed to fetch"))).toBe(false);
  });
});

describe("errorMessage", () => {
  test("API の失敗は server のメッセージを、それ以外は接続できないことを返す", () => {
    expect(errorMessage(new ApiError(409, "NO_OPEN_QUESTION", "すでに回答済みです"))).toBe("すでに回答済みです");
    expect(errorMessage(new TypeError("Failed to fetch"))).toBe("server に接続できません");
    expect(errorMessage(undefined)).toBe("server に接続できません");
  });
});

describe("shouldRetry", () => {
  test("4xx は再試行せず、5xx と通信の失敗は3回まで再試行する", () => {
    expect(shouldRetry(0, new ApiError(404, "NOT_FOUND", ""))).toBe(false);
    expect(shouldRetry(0, new ApiError(409, "NO_OPEN_QUESTION", ""))).toBe(false);
    expect(shouldRetry(0, new ApiError(503, "DB_BUSY", ""))).toBe(true);
    expect(shouldRetry(2, new TypeError("Failed to fetch"))).toBe(true);
    expect(shouldRetry(3, new TypeError("Failed to fetch"))).toBe(false);
  });
});
