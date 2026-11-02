import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeCsv, parseCsv } from "../src/core/csv.js";
import { applyUpdates, editField, fromResumeFile, importRow, toResumeFile } from "../src/core/plan.js";
import { buildOneSheet, buildSummary, buildVillageRow, evacuationSentence, hasCityConsent, toCsvText } from "../src/core/output.js";
import { mockScribe } from "../src/server/mock-talk.js";
import { createLimiter } from "../src/server/limits.js";

const read = (f) => readFileSync(new URL(`../samples/${f}`, import.meta.url));
const config = JSON.parse(read("hakka-village.config.json"));
const mapping = JSON.parse(read("keahakka.mapping.json"));
const script = JSON.parse(read("okano.script.json"));

function okano() {
  const table = parseCsv(decodeCsv(read("keahakka_okano.csv")));
  const state = importRow({ headers: table.headers, row: table.rows[0], mapping });
  script.forEach((m, i) => applyUpdates(state.plan, mockScribe(m), i + 1));
  return state;
}
const column = (row, name) => row[config.columns.indexOf(name)];

test("国の項目に合わせた列が計画に入る", () => {
  const { plan } = okano();
  assert.equal(plan.care.stairs.source, "csv");
  assert.equal(plan.home.usualRoom.value, "居間");
  assert.equal(plan.home.bedroom.value, "家の裏の部屋");
});

test("同意がなければ市向けに出せず、同意した項目だけが出る", () => {
  const state = okano();
  assert.equal(hasCityConsent(state.plan), false);
  state.plan.consent.evacuation = "yes";
  assert.equal(hasCityConsent(state.plan), true);
  const row = buildVillageRow({ ...state, config, createdOn: "2026-11-08" });
  assert.equal(column(row, "氏名"), "岡野 ハル");
  assert.equal(column(row, "避難場所"), "ハッカ村公民館");
  assert.equal(column(row, "電話番号"), "", "連絡先は同意していない");
  assert.equal(column(row, "要介護度"), "");
  assert.equal(column(row, "避難支援者1氏名"), "");
  assert.equal(column(row, "特記事項"), "", "備考は写さない");
});

test("手伝う人が決まっていなくても出せて、未決定と出る", () => {
  const state = okano();
  state.plan.consent = { contact: "yes", care: "yes", evacuation: "yes", helper: "yes" };
  const row = buildVillageRow({ ...state, config, createdOn: "2026-11-08" });
  assert.equal(column(row, "避難支援者1氏名"), "未決定");
  assert.equal(column(row, "避難支援者2氏名"), "", "2人目は任意");
  assert.equal(column(row, "緊急連絡先1電話"), "000-0000-0001");
  assert.equal(column(row, "自治会名"), "未決定");
  assert.equal(row.length, config.columns.length);
});

test("引き受けてもらえた人だけ、名前が出る", () => {
  const state = okano();
  state.plan.helpers[0].asked = true;
  state.people.push({ name: "野田 修", alias: "隣の人", phone: "00000000003" });
  state.plan.consent.helper = "yes";
  const row = buildVillageRow({ ...state, config, createdOn: "2026-11-08" });
  assert.equal(column(row, "避難支援者1氏名"), "野田 修");
  assert.equal(column(row, "避難支援者1電話"), "000-0000-0003");
});

test("避難方法の文は決まった形で作る", () => {
  const { plan } = okano();
  assert.equal(evacuationSentence(plan, "隣の人"), "隣の人と車いすで、準備を入れて45分");
  assert.match(evacuationSentence(plan, ""), /未決定/);
});

test("今日できたことと次の一歩が残る", () => {
  const { plan } = okano();
  plan.requests = ["雨の夜に、電話を1本", "石段を降りるときだけ、手を貸してください"];
  plan.requestsDone = ["雨の夜に、電話を1本"];
  const { done, next } = buildSummary(plan, [{ text: "火・木の昼は、隣の人がいません。", request: "雨の予報の日の昼に、電話を1本（娘さんへ）" }]);
  assert.ok(done.some((d) => d.includes("頼めたこと：雨の夜")));
  assert.ok(done.some((d) => d.includes("45分")));
  assert.ok(next.includes("頼む：石段を降りるときだけ、手を貸してください"));
  assert.ok(next.some((n) => n.includes("昼に、電話")));
  assert.ok(!next.some((n) => n.includes("雨の夜")), "頼めたものは次に出さない");
});

test("手伝う人が空でも、本人の1枚ができる", () => {
  const state = okano();
  const sheet = buildOneSheet(state);
  const rows = Object.fromEntries(sheet.rows);
  assert.equal(sheet.name, "岡野 ハル");
  assert.equal(rows["どこへ"], "ハッカ村公民館");
  assert.equal(rows["誰と"], "");
  assert.match(sheet.notes.join(), /必ず来られるとは限りません/);
});

test("CSV の文は数式として動かない", () => {
  const text = toCsvText(["a", "b"], ["=1+1", 'x,"y"']);
  assert.ok(text.startsWith("﻿"));
  assert.ok(text.includes("'=1+1"));
  assert.ok(text.includes('"x,""y"""'));
});

test("続き用ファイルで再開でき、人が直した印も残る", () => {
  const state = okano();
  editField(state.plan, "evacuation.place", "ハッカ村小学校");
  state.people.push({ name: "野田 修", alias: "隣の人", phone: "" });
  const again = fromResumeFile(JSON.parse(JSON.stringify(toResumeFile(state))));
  assert.equal(again.plan.evacuation.place.value, "ハッカ村小学校");
  assert.equal(again.plan.evacuation.place.source, "human");
  assert.equal(again.plan.care.level.value, "要介護1");
  assert.equal(again.plan.helpers[0].alias, "隣の人");
  assert.equal(again.people[0].name, "野田 修");
  assert.equal(again.identity["self.name"], "岡野 ハル");
  assert.throws(() => fromResumeFile({ kind: "other" }));
});

test("回数の上限を超えると止める", () => {
  let t = Date.UTC(2026, 10, 8, 0, 0, 0);
  const limiter = createLimiter({ perMinute: 2, perDay: 3, now: () => t });
  assert.equal(limiter.check("a").ok, true);
  assert.equal(limiter.check("a").ok, true);
  assert.equal(limiter.check("a").ok, false);
  t += 61_000;
  assert.equal(limiter.check("a").ok, true);
  assert.match(limiter.check("b").reason, /本日の上限/);
  t += 24 * 3600_000;
  assert.equal(limiter.check("b").ok, true);
});
