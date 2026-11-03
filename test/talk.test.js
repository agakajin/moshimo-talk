// 岡野さんの台本を通す。点検は「出るべき指摘」と「出てはいけない指摘」で見る
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeCsv, parseCsv } from "../src/core/csv.js";
import { applyUpdates, editField, importRow, planForClaude, serviceGaps } from "../src/core/plan.js";
import { nextTopic } from "../src/core/talk.js";
import { mockCheck, mockScribe } from "../src/server/mock-talk.js";
import { validateCheckPayload, validateScribePayload } from "../src/server/validate.js";

const MEMOS = [
  "家の裏の部屋で寝ている。裏は崖で、大雨のときが心配。ほかの災害は心配していないとのこと",
  "公民館。前にも行ったことがある",
  "長い距離は車いす",
  "一人では降りられない。誰かに手を引いてもらえば、杖で一段ずつ。車いすは階段の下に置いておく。準備に15分、公民館まで30分くらい",
  "火・木は一日中家にいる。月水金の昼はデイのまま",
  "隣の親子とあいさつをする。平日の昼は二人とも仕事で村の外。夜と休日は家にいる。避難のことはまだ何も頼んでいない",
  "家の固定電話だけ。携帯は持っていない",
  "血圧の薬と補聴器の電池を、玄関の袋にまとめておくことにした。本人が持って出る。ほかに配慮することはない",
];
const YARD = { label: "坂・階段・狭い道", opener: "家の前の階段は、どうやって降りますか？" };

function okano() {
  const table = parseCsv(decodeCsv(readFileSync(new URL("../samples/keahakka_okano.csv", import.meta.url))));
  const mapping = JSON.parse(readFileSync(new URL("../samples/keahakka.mapping.json", import.meta.url), "utf-8"));
  return importRow({ headers: table.headers, row: table.rows[0], mapping });
}
const check = (plan) => mockCheck({ plan, gaps: serviceGaps(plan), targetMinutes: 60, yardstick: YARD });

test("火・木の話から入れる順で、きっかけが1つずつ出る", () => {
  const { plan } = okano();
  const gaps = serviceGaps(plan);
  assert.equal(nextTopic(plan, { gaps }).id, "hazards");
  assert.equal(nextTopic(plan, { gaps, skipped: ["hazards", "place", "means", "time"] }).text, "火・木の昼は、どう過ごしていますか？");
});

test("寝室が分かっていれば聞き直さない", () => {
  const { plan } = okano();
  assert.match(nextTopic(plan, {}).text, /家の裏の部屋で寝ていらっしゃる/);
  plan.home.bedroom.value = null;
  assert.equal(nextTopic(plan, {}).text, "大雨の夜は、いつもどの部屋で寝ていますか？");
});

test("持ち出しは要点だけが入る", () => {
  const { plan } = okano();
  applyUpdates(plan, mockScribe(MEMOS[7]), 1);
  assert.equal(plan.carry.value, "血圧の薬と補聴器の電池（玄関の袋）");
});

test("台本どおりに話すと、段取りが埋まり、石段の割り込みが出る", () => {
  const { plan } = okano();
  const gaps = serviceGaps(plan);
  MEMOS.slice(0, 3).forEach((m, i) => applyUpdates(plan, mockScribe(m), i + 1));
  const before = check(plan);
  assert.equal(before.find((f) => f.interrupt)?.opener, YARD.opener);

  MEMOS.slice(3).forEach((m, i) => applyUpdates(plan, mockScribe(m), i + 4));
  assert.equal(plan.evacuation.place.value, "ハッカ村公民館");
  assert.equal(plan.evacuation.prepMinutes.value, "15");
  assert.equal(plan.evacuation.moveMinutes.value, "30");
  assert.equal(plan.contactMeans.value, "固定電話のみ");
  assert.equal(plan.helpers[0].asked, false);
  assert.equal(plan.hazards.noOthers, true);
  assert.equal(nextTopic(plan, { gaps }), null);
});

test("最後は頼みごとの案が出て、言ってはいけない指摘は出ない", () => {
  const { plan } = okano();
  MEMOS.forEach((m, i) => applyUpdates(plan, mockScribe(m), i + 1));
  const findings = check(plan);
  const requests = findings.filter((f) => f.request).map((f) => f.request);
  assert.ok(requests.includes("雨の夜に、電話を1本"));
  assert.ok(requests.includes("石段を降りるときだけ、手を貸してください"));
  assert.ok(requests.some((r) => r.includes("昼に、電話を1本")));
  assert.ok(!findings.some((f) => f.interrupt));
  assert.ok(!findings.some((f) => f.id === "in-time"), "45分は目安の中");
  const text = findings.map((f) => f.text).join();
  assert.ok(!/月|水|金/.test(text), "デイの日は指摘しない");
  assert.ok(!/血圧|薬が/.test(text), "医療の判断をしない");
});

test("間に合わないときだけ指摘する", () => {
  const { plan } = okano();
  applyUpdates(plan, [{ path: "evacuation.prepMinutes", value: "40" }, { path: "evacuation.moveMinutes", value: "30" }], 1);
  assert.ok(check(plan).some((f) => f.id === "in-time"));
});

test("人が直した欄は上書きせず、尋ねるために返す", () => {
  const { plan } = okano();
  editField(plan, "evacuation.place", "ハッカ村小学校");
  const conflicts = applyUpdates(plan, mockScribe("公民館。前にも行ったことがある"), 1);
  assert.equal(plan.evacuation.place.value, "ハッカ村小学校");
  assert.equal(plan.evacuation.place.source, "human");
  assert.equal(conflicts[0].proposed, "ハッカ村公民館");
});

test("読めなかった予定の文は Claude に渡さない", () => {
  const plan = okano().plan;
  plan.care.weekly.value.unread = ["実在デイ 週に何回か"];
  assert.ok(!JSON.stringify(planForClaude(plan)).includes("実在デイ"));
  assert.ok(validateCheckPayload({ plan, gaps: null }).length > 0);
  assert.deepEqual(validateCheckPayload({ plan: planForClaude(plan), gaps: null }), []);
});

test("電話番号らしい数字や余計な項目はサーバーで止める", () => {
  const { plan } = okano();
  const safe = planForClaude(plan);
  assert.deepEqual(validateScribePayload({ memo: "公民館へ", plan: safe }), []);
  assert.ok(validateScribePayload({ memo: "番号は 000-0000-0001", plan: safe }).length > 0);
  assert.ok(validateScribePayload({ memo: "公民館へ", plan: safe, identity: {} }).length > 0);
  assert.ok(validateScribePayload({ memo: " ", plan: safe }).length > 0);
});

test("台本：話のきっかけの問いと、次の声メモが合う", async () => {
  const { readFileSync } = await import("node:fs");
  const { parseCsv, decodeCsv } = await import("../src/core/csv.js");
  const { mockScribe } = await import("../src/server/mock-talk.js");
  const { nextTopic } = await import("../src/core/talk.js");
  const read = (name) => readFileSync(new URL(`../samples/${name}`, import.meta.url));
  const { headers, rows } = parseCsv(decodeCsv(read("keahakka_okano.csv")));
  const { plan } = importRow({ headers, row: rows[0], mapping: JSON.parse(read("keahakka.mapping.json")) });
  JSON.parse(read("okano.script.json")).forEach((memo, i) => applyUpdates(plan, mockScribe(memo), i + 1));
  assert.equal(plan.home.community.value, "中央自治会");
  assert.equal(plan.contactMeans.value, "固定電話のみ");
  assert.equal(nextTopic(plan, { gaps: serviceGaps(plan) }), null, "用意した話はすべて答えられている");
});
