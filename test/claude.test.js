// 本物の Claude は呼ばない。送る中身と、答えの受け取り方を確かめる
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeCsv, parseCsv } from "../src/core/csv.js";
import { maskTable } from "../src/core/mask.js";
import { applyUpdates, editField, importRow, planForClaude, serviceGaps } from "../src/core/plan.js";
import { acceptColumns, acceptFindings, acceptScribe, ClaudeError, createClaude, summarizePlan, timeFinding } from "../src/server/claude.js";
import { COMMON_YARDSTICKS, READER, SCRIBE, checkPrompt } from "../src/server/prompts.js";

const read = (name) => readFileSync(new URL(`../samples/${name}`, import.meta.url));
const VILLAGE = JSON.parse(read("hakka-village.config.json"));
const YARDSTICKS = [...COMMON_YARDSTICKS, ...VILLAGE.yardsticks];

function okano() {
  const table = parseCsv(decodeCsv(read("keahakka_okano.csv")));
  return { table, ...importRow({ headers: table.headers, row: table.rows[0], mapping: JSON.parse(read("keahakka.mapping.json")) }) };
}

function fakeClient(answer, extra = {}) {
  const calls = [];
  const create = async (req) => {
    calls.push(req);
    if (answer instanceof Error) throw answer;
    return { model: req.model, usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn", content: [{ type: "text", text: typeof answer === "string" ? answer : JSON.stringify(answer) }], ...extra };
  };
  return { calls, beta: { messages: { create } } };
}
const claude = (client) => createClaude({ client, village: VILLAGE });

test("頼み方は決まった形で、使えない指定を送らない", async () => {
  const client = fakeClient({ updates: [], helpers: [] });
  await claude(client).scribe({ memo: "公民館へ", plan: planForClaude(okano().plan) });
  const [req] = client.calls;
  assert.equal(req.model, "claude-opus-5-5");
  assert.equal(req.fallbacks, "default");
  assert.deepEqual(req.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(req.output_config.effort, "low");
  assert.equal(req.output_config.format.type, "json_schema");
  for (const key of ["thinking", "tool_choice", "temperature", "top_p"]) assert.ok(!(key in req), key);
});

test("答えの形は、すべての入れ物で余計な項目を禁じている", () => {
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (node === null || typeof node !== "object") return;
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
    }
    for (const key of ["minLength", "maxLength", "minimum", "maximum"]) assert.ok(!(key in node), key);
    Object.values(node).forEach(visit);
  };
  [READER, SCRIBE, checkPrompt(YARDSTICKS)].forEach((p) => visit(p.schema));
});

test("氏名・住所・電話番号・生年月日は Claude への中身に入らない", async () => {
  const { identity, plan, table } = okano();
  const secrets = Object.values(identity).filter((v) => typeof v === "string" && v.length > 1);
  assert.ok(secrets.length >= 5);

  const talk = fakeClient({ updates: [], helpers: [], findings: [] });
  const c = claude(talk);
  await c.scribe({ memo: "公民館へ", plan: planForClaude(plan) });
  await c.check({ plan: planForClaude(plan), gaps: serviceGaps(plan) });

  const reader = fakeClient({ results: [] });
  await claude(reader).readColumns(maskTable(table).payload);

  const sent = JSON.stringify([...talk.calls, ...reader.calls].map((r) => r.messages));
  for (const secret of secrets) assert.ok(!sent.includes(secret), "本物の値が混ざった");
});

test("計画は値だけにして送り、同意や番号は渡さない", () => {
  const { plan } = okano();
  plan.consent.care = "agreed";
  plan.helpers.push({ alias: "隣の人", asked: false, awayWeekdayDaytime: true, memoId: 3 });
  const s = summarizePlan(planForClaude(plan));
  assert.ok(!("consent" in s));
  assert.ok(!("status" in s.home));
  assert.equal(s.home.bedroom, plan.home.bedroom.value);
  assert.equal(s.helpers[0].alias, "隣の人");
  assert.equal(s.evacuation, undefined, "空の欄は送らない");
});

test("読み解き：不明・作り話の欄・答えの無い列は、人に聞く形に戻す", () => {
  const columns = [{ header: "氏名" }, { header: "謎の列" }, { header: "答えなし" }, { header: "歩行" }];
  const out = acceptColumns([
    { header: "歩行", target: "care.mobility", confidence: "high" },
    { header: "氏名", target: "self.name", confidence: "high" },
    { header: "謎の列", target: "self.secret", confidence: "high" },
    { header: "勝手に足した列", target: "self.phone", confidence: "high" },
  ], columns);
  assert.deepEqual(out.map((r) => r.header), ["氏名", "謎の列", "答えなし", "歩行"]);
  assert.deepEqual(out.map((r) => r.target), ["self.name", "unknown", "unknown", "care.mobility"]);
  assert.equal(out[1].confidence, "low");
});

test("書き取り：メモに根拠の無い書き込みは捨てる", () => {
  const memo = "公民館まで、車いすで30分くらい。ほかの災害は心配していない。";
  const out = acceptScribe({
    updates: [
      { path: "evacuation.place", value: "公民館", quote: "公民館まで" },
      { path: "evacuation.moveMinutes", value: "３０分", quote: "30分くらい" },
      { path: "hazards.noOthers", value: "true", quote: "ほかの災害は心配していない" },
      { path: "contactMeans", value: "携帯電話", quote: "携帯を持っている" },
      { path: "carry", value: "薬", quote: "" },
      { path: "evacuation.prepMinutes", value: "しばらく", quote: "30分くらい" },
      { path: "consent.care", value: "agreed", quote: "公民館まで" },
      { path: "evacuation.route", value: "000-0000-0001", quote: "公民館まで" },
    ],
    helpers: [
      { alias: "隣の人", awayWeekdayDaytime: false, asked: false, quote: "車いすで" },
      { alias: "娘さん", awayWeekdayDaytime: false, asked: true, quote: "娘が来る" },
    ],
  }, memo);
  assert.deepEqual(out, [
    { path: "evacuation.place", value: "公民館" },
    { path: "evacuation.moveMinutes", value: "30" },
    { path: "hazards.noOthers", value: true },
    { path: "helpers.add", value: { alias: "隣の人", awayWeekdayDaytime: false, asked: false } },
  ]);
});

test("書き取りの答えは今の計画に入り、人が直した欄は上書きしない", async () => {
  const { plan } = okano();
  editField(plan, "evacuation.place", "ハッカ村小学校");
  const client = fakeClient({
    updates: [
      { path: "evacuation.place", value: "公民館", quote: "公民館" },
      { path: "evacuation.means", value: "車いす", quote: "車いす" },
    ],
    helpers: [],
  });
  const { updates } = await claude(client).scribe({ memo: "公民館へ車いすで", plan: planForClaude(plan) });
  const conflicts = applyUpdates(plan, updates, 1);
  assert.equal(plan.evacuation.place.value, "ハッカ村小学校");
  assert.equal(plan.evacuation.means.value, "車いす");
  assert.equal(conflicts[0].proposed, "公民館");
});

test("点検：物差しに無い指摘と医療の判断を捨て、約束する頼みごとを外す", () => {
  const f = (o) => ({ yardstick: "一本足", text: "知らせの手段が1つです。", interrupt: false, opener: null, request: null, ...o });
  const out = acceptFindings([
    f({ yardstick: "思いつき" }),
    f({ text: "血圧の薬を減らす相談を。" }),
    f({ yardstick: "持ち出し", text: "受診の予定を確かめましょう。" }),
    f({ request: "雨の夜に、電話を1本" }),
    f({ yardstick: "時間帯", text: "昼の様子を聞けていません。", request: "必ず駆けつけてください" }),
    f({ yardstick: "坂・階段・狭い道", text: "階段を聞けていません。", interrupt: true, opener: "家の前の階段は、どうやって降りますか？" }),
    f({ yardstick: "最低ライン", text: "逃げる先がまだです。", interrupt: true, opener: null }),
  ], YARDSTICKS);
  assert.deepEqual(out.map((x) => x.yardstick), ["一本足", "時間帯", "坂・階段・狭い道", "最低ライン"]);
  assert.equal(out[0].request, "雨の夜に、電話を1本");
  assert.ok(!("request" in out[1]));
  assert.equal(out[2].interrupt, true);
  assert.equal(out[2].opener, "家の前の階段は、どうやって降りますか？");
  assert.ok(!("interrupt" in out[3]), "質問の無い割り込みは出さない");
  assert.equal(new Set(out.map((x) => x.id)).size, 4);
});

test("割り込みの番号は答えが変わっても同じで、同じ話を何度も割り込まない", () => {
  const f = (text) => ({ yardstick: "坂・階段・狭い道", text, interrupt: true, opener: "階段は？", request: null });
  assert.equal(acceptFindings([f("言い方その1")], YARDSTICKS)[0].id, acceptFindings([f("言い方その2")], YARDSTICKS)[0].id);
});

test("間に合うかの足し算はプログラムがする", async () => {
  const { plan } = okano();
  applyUpdates(plan, [{ path: "evacuation.prepMinutes", value: "15" }, { path: "evacuation.moveMinutes", value: "30" }], 1);
  assert.equal(timeFinding(plan, 60), null);
  applyUpdates(plan, [{ path: "evacuation.prepMinutes", value: "40" }], 2);
  const { findings } = await claude(fakeClient({ findings: [] })).check({ plan: planForClaude(plan), gaps: null });
  assert.equal(findings[0].id, "in-time");
  assert.match(findings[0].text, /70分/);
});

test("断られた・途中で切れた・読めない答えは、失敗として返す", async () => {
  const payload = { memo: "公民館へ", plan: planForClaude(okano().plan) };
  for (const client of [
    fakeClient({}, { stop_reason: "refusal", content: [] }),
    fakeClient({}, { stop_reason: "max_tokens" }),
    fakeClient("読めない答え"),
    fakeClient({}, { content: [] }),
  ]) {
    await assert.rejects(claude(client).scribe(payload), ClaudeError);
  }
});

test("通信の失敗は日本語で返し、混雑だけ待てば直ると伝える", async (t) => {
  t.mock.method(console, "error", () => {});
  const payload = { memo: "公民館へ", plan: planForClaude(okano().plan) };
  const fail = (status) => Object.assign(new Error("中身を含むかもしれない文"), { status });
  await assert.rejects(claude(fakeClient(fail(429))).scribe(payload), (e) => e.status === 503 && /混み合って/.test(e.message));
  await assert.rejects(claude(fakeClient(fail(529))).scribe(payload), (e) => e.status === 503);
  await assert.rejects(claude(fakeClient(fail(401))).scribe(payload), (e) => e.status === 502 && !e.message.includes("中身"));
});

test("かかった量を知らせる", async () => {
  const seen = [];
  const c = createClaude({ client: fakeClient({ results: [] }), village: VILLAGE, onUsage: (u) => seen.push(u) });
  await c.readColumns({ columns: [{ header: "氏名", withheld: false, samples: ["文字列1"] }] });
  assert.equal(seen[0].role, "reader");
  assert.equal(seen[0].usage.output_tokens, 1);
});
