import { EventEmitter } from "node:events";
import { appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ launches: [], windows: [] }));
vi.mock("electron", () => ({ app: { isPackaged: true, getPath: () => tmpdir() } }));
vi.mock("node:child_process", () => ({
  spawn: (_file, args) => {
    const proc = new EventEmitter();
    const arg = flag => args[args.indexOf(flag) + 1];
    fixture.launches.push({ proc, output: arg("-o"), stop: arg("--stop-file"), finish: arg("--finish-file") });
    return proc;
  },
}));

Object.defineProperty(process, "resourcesPath", { configurable: true, value: "/synthetic-speech-resources" });
const { startSpeech, stopSpeech, finishSpeech } = await import("./speech.mjs");

const launch = () => {
  const events = [];
  const win = { isDestroyed: () => false, webContents: { send: (channel, body) => events.push({ channel, body }) } };
  startSpeech(win);
  return { ...fixture.launches.at(-1), events };
};
const emit = (session, line) => appendFileSync(session.output, `${JSON.stringify(line)}\n`);

afterEach(() => {
  stopSpeech();
  for (const session of fixture.launches) session.proc.emit("close", 0);
  fixture.launches.length = 0;
});

describe.skipIf(process.platform !== "darwin")("native speech file transport", () => {
  it("assembles utterances before delivering them and keeps partials partial for calls", async () => {
    const session = launch();
    emit(session, { text: "最初の文章。", partial: true, utteranceFinal: true, speechStart: 0 });
    emit(session, { text: "次の文章。", partial: true });
    emit(session, { text: "", partial: false });
    session.proc.emit("close", 0);
    expect(session.events).toEqual([
      { channel: "speech:transcript", body: expect.objectContaining({ text: "最初の文章。", partial: true }) },
      { channel: "speech:transcript", body: { text: "最初の文章。 次の文章。", partial: true } },
      { channel: "speech:transcript", body: { text: "最初の文章。 次の文章。", partial: false } },
      { channel: "speech:end", body: { code: 0, reason: "completed" } },
    ]);
    expect(existsSync(session.output)).toBe(false);
  });

  it("rejects results and close events from a stopped session", () => {
    const session = launch();
    stopSpeech();
    expect(existsSync(session.stop)).toBe(true);
    emit(session, { text: "停止後の認識結果", partial: false });
    session.proc.emit("close", 0);
    expect(session.events).toEqual([]);
  });

  it("isolates a replacement session even if the older helper flushes late", () => {
    const first = launch();
    const second = launch();
    emit(first, { text: "古い認識結果", partial: false });
    first.proc.emit("close", 0);
    emit(second, { text: "新しい認識結果", partial: false });
    second.proc.emit("close", 0);
    expect(first.events).toEqual([]);
    expect(second.events[0].body.text).toBe("新しい認識結果");
  });

  it("keeps push-to-talk finish separate from cancellation", () => {
    const session = launch();
    finishSpeech();
    expect(existsSync(session.finish)).toBe(true);
    expect(existsSync(session.stop)).toBe(false);
    emit(session, { text: "確定結果", partial: false });
    session.proc.emit("close", 0);
    expect(session.events[0].body.text).toBe("確定結果");
  });
});
