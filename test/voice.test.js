import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseKey, createPushToTalk, keyLabel, keyTriggers } from "../src/core/voice.js";

function setup() {
  const made = [];
  class Fake {
    constructor() { made.push(this); this.started = 0; this.stopped = 0; }
    start() { this.started += 1; }
    stop() { this.stopped += 1; }
    hear(...parts) {
      this.onresult({ results: parts.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal })) });
    }
  }
  const log = { text: "", interim: "", states: [] };
  let pending = null;
  const talk = createPushToTalk({
    Recognition: Fake,
    onText: (t) => { log.text = t; },
    onInterim: (t) => { log.interim = t; },
    onState: (s, detail) => log.states.push(detail ? `${s}:${detail}` : s),
    setTimer: (fn) => { pending = fn; return 1; },
    clearTimer: () => { pending = null; },
  });
  const hold = () => { talk.press(); const fn = pending; pending = null; fn(); };
  return { talk, made, log, hold, waiting: () => pending !== null, pendingFn: () => pending };
}

test("短く押すと、マイクを動かさず送る合図になる", () => {
  const { talk, made, log, waiting } = setup();
  assert.equal(talk.press(), true);
  assert.equal(waiting(), true);
  talk.release();
  assert.equal(made.length, 0);
  assert.deepEqual(log.states, ["tap"]);
  assert.equal(waiting(), false);
});

test("押し続けると聞き始め、離すと止まる。送る合図は出さない", () => {
  const { talk, made, log, hold } = setup();
  hold();
  assert.equal(made[0].started, 1);
  assert.equal(made[0].continuous, true);
  assert.equal(made[0].stopped, 0);
  talk.release();
  assert.equal(made[0].stopped, 1);
  made[0].onend();
  assert.deepEqual(log.states, ["listening", "finishing", "idle"]);
});

test("聞き始める前に指が外れたり画面を離れたりしたら、送らない", () => {
  const { talk, made, log, waiting } = setup();
  talk.press();
  talk.cancel();
  assert.equal(waiting(), false);
  assert.equal(made.length, 0);
  assert.deepEqual(log.states, []);
  assert.equal(talk.press(), true);
});

test("聞いている間に画面を離れたら、止めて文字は残す", () => {
  const { talk, made, log, hold } = setup();
  hold();
  made[0].hear(["公民館", true]);
  talk.cancel();
  assert.equal(made[0].stopped, 1);
  made[0].onend();
  assert.equal(log.text, "公民館");
  assert.equal(log.states.includes("tap"), false);
});

test("離したあとに届いた文字も受け取る", () => {
  const { talk, made, log, hold } = setup();
  hold();
  talk.release();
  made[0].hear(["裏の部屋でお休みなんですね", true]);
  made[0].onend();
  assert.equal(log.text, "裏の部屋でお休みなんですね");
});

test("文字を待っている間に押しても、送らず始めない", () => {
  const { talk, made, log, hold } = setup();
  hold();
  talk.release();
  assert.equal(talk.press(), false);
  talk.release();
  assert.equal(log.states.includes("tap"), false);
  assert.equal(made.length, 1);
  made[0].onend();
  assert.equal(log.states.at(-1), "idle");
  assert.equal(talk.press(), true);
});

test("同じ結果がもう一度届いても二重にしない", () => {
  const { made, log, hold } = setup();
  hold();
  made[0].hear(["公民館", true]);
  made[0].hear(["公民館", true]);
  made[0].hear(["公民館", true], ["まで", true]);
  assert.equal(log.text, "公民館まで");
});

test("途中の文字は確定の文字に混ぜない", () => {
  const { made, log, hold } = setup();
  hold();
  made[0].hear(["公民館", true], ["まで三十", false]);
  assert.equal(log.text, "公民館");
  assert.equal(log.interim, "まで三十");
});

test("押している間に音声認識が終わったら、聞き直して文字をつなぐ", () => {
  const { talk, made, log, hold } = setup();
  hold();
  made[0].hear(["裏の部屋で", true]);
  made[0].onend();
  assert.equal(made.length, 2);
  assert.equal(made[1].started, 1);
  made[1].hear(["お休みなんですね", true]);
  talk.release();
  made[1].onend();
  assert.equal(made.length, 2);
  assert.equal(log.text, "裏の部屋でお休みなんですね");
});

test("マイクが使えないときは聞き直さず、理由を知らせる", () => {
  const { made, log, hold } = setup();
  hold();
  made[0].onerror({ error: "not-allowed" });
  made[0].onend();
  assert.equal(made.length, 1);
  assert.equal(log.states.at(-1), "error:not-allowed");
});

test("黙っていただけなら、押している間は聞き直す", () => {
  const { made, hold } = setup();
  hold();
  made[0].onerror({ error: "no-speech" });
  made[0].onend();
  assert.equal(made.length, 2);
});

test("次に押したときは、前の文字を引き継がない", () => {
  const { talk, made, log, hold } = setup();
  hold();
  made[0].hear(["一回目", true]);
  talk.release();
  made[0].onend();
  hold();
  made[1].hear(["二回目", true]);
  assert.equal(log.text, "二回目");
});

test("押していないのに離しても何もしない", () => {
  const { talk, log } = setup();
  talk.release();
  talk.cancel();
  assert.deepEqual(log.states, []);
});

test("画面の操作に使うキーは、録音に選べない", () => {
  assert.equal(chooseKey({ code: "F9" }), "F9");
  assert.equal(chooseKey({ code: "", key: "AudioVolumeUp" }), "AudioVolumeUp");
  assert.equal(chooseKey({ code: "Tab" }), null);
  assert.equal(chooseKey({ code: "Escape" }), null);
  assert.equal(chooseKey({ code: "Space" }), null);
  assert.equal(chooseKey({ code: "Enter" }), null);
});

test("文字を打っている間は、文字のキーで録音を始めない", () => {
  assert.equal(keyTriggers("KeyK", "KeyK", false), true);
  assert.equal(keyTriggers("KeyK", "KeyK", true), false);
  assert.equal(keyTriggers("F2", "F2", true), true);
  assert.equal(keyTriggers("F3", "F2", false), false);
});

test("キーの名前を読みやすく出す", () => {
  assert.equal(keyLabel("KeyK"), "K");
  assert.equal(keyLabel("Digit5"), "5");
  assert.equal(keyLabel("F2"), "F2");
});

test("文字を待っている間は busy。終われば戻る", () => {
  const { talk, made, hold } = setup();
  assert.equal(talk.busy(), false);
  hold();
  assert.equal(talk.busy(), true);
  talk.release();
  assert.equal(talk.busy(), true);
  made[0].onend();
  assert.equal(talk.busy(), false);
});

test("確定しないまま終わった文字も残す", () => {
  const { talk, made, log, hold } = setup();
  hold();
  made[0].hear(["公民館まで", false]);
  talk.release();
  made[0].onend();
  assert.equal(log.text, "公民館まで");
});

test("音声認識が始められなくても、ボタンを固めない", () => {
  class Broken { start() { throw new Error("だめ"); } }
  const states = [];
  let pending = null;
  const talk = createPushToTalk({
    Recognition: Broken,
    onText: () => {},
    onInterim: () => {},
    onState: (s, d) => states.push(d ? `${s}:${d}` : s),
    setTimer: (fn) => { pending = fn; return 1; },
    clearTimer: () => {},
  });
  talk.press();
  pending();
  assert.equal(states.at(-1), "error:start");
  assert.equal(talk.busy(), false);
});

test("離したあと終わりの知らせが来なくても、時間切れで戻る", () => {
  const { talk, log, hold, pendingFn } = setup();
  hold();
  talk.release();
  pendingFn()();
  assert.equal(talk.busy(), false);
  assert.equal(log.states.at(-1), "idle");
});

test("知らない失敗では聞き直し続けない", () => {
  const { made, log, hold } = setup();
  hold();
  made[0].onerror({ error: "language-not-supported" });
  made[0].onend();
  assert.equal(made.length, 1);
  assert.equal(log.states.at(-1), "error:language-not-supported");
});
