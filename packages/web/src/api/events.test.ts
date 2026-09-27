import { describe, expect, test } from "bun:test";
import { type ConnectionState, connectServerEvents, type EventSourceLike } from "./events";

function fakeSource() {
  const listeners = new Map<string, (() => void)[]>();
  const state = { closed: false };
  const source: EventSourceLike = {
    addEventListener: (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    close: () => {
      state.closed = true;
    },
  };
  const emit = (type: string) => {
    for (const listener of listeners.get(type) ?? []) listener();
  };
  return { source, emit, state };
}

function connect() {
  const fake = fakeSource();
  const log = { invalidated: 0, states: [] as ConnectionState[] };
  const stop = connectServerEvents({
    open: () => fake.source,
    onInvalidate: () => {
      log.invalidated += 1;
    },
    onStateChange: (s) => log.states.push(s),
  });
  return { fake, log, stop };
}

describe("connectServerEvents", () => {
  test("ready と change でクエリを無効にし、ready で接続済みにする", () => {
    const { fake, log } = connect();
    expect(log.states).toEqual(["connecting"]);
    fake.emit("ready");
    fake.emit("change");
    expect(log.invalidated).toBe(2);
    expect(log.states).toEqual(["connecting", "ready"]);
  });

  test("error で接続中に戻り、再接続の ready でまた無効にする", () => {
    const { fake, log } = connect();
    fake.emit("ready");
    fake.emit("error");
    fake.emit("ready");
    expect(log.states).toEqual(["connecting", "ready", "connecting", "ready"]);
    expect(log.invalidated).toBe(2);
  });

  test("戻り値の関数で接続を閉じる", () => {
    const { fake, stop } = connect();
    stop();
    expect(fake.state.closed).toBe(true);
  });
});
