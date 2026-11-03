import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeCsv, parseCsv } from "../src/core/csv.js";
import { createPlan, applyUpdates, editField, fromResumeFile, importRow, toResumeFile } from "../src/core/plan.js";
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

test("今日できたこと：様式から足した欄も、話したなら数える。CSV の値は数えない", () => {
  const plan = createPlan();
  plan.extra.x1 = { status: "filled", value: "2階", source: "voice", memoId: 1 };
  plan.extra.x2 = { status: "filled", value: "架空医院", source: "csv", memoId: null };
  const { done } = buildSummary(plan, [], [{ path: "extra.x1", label: "居住階" }, { path: "extra.x2", label: "主治医" }]);
  assert.deepEqual(done, ["話せたこと：居住階"]);
});

test("準備が未記入なのに、準備を入れてと言わない。合計の列も空にする", () => {
  const plan = createPlan();
  applyUpdates(plan, [{ path: "evacuation.means", value: "車" }, { path: "evacuation.moveMinutes", value: "20" }], 1);
  assert.equal(evacuationSentence(plan, "隣の人"), "隣の人と車で、移動20分（準備の時間はこれから）");
  const config = { columns: ["時間"], targets: { 時間: "evacuation.minutes" }, alwaysColumns: ["時間"], neverColumns: [], consentGroups: {}, blankValue: "未決定" };
  assert.deepEqual(buildVillageRow({ plan, identity: {}, config, createdOn: "x" }), ["未決定"]);
  applyUpdates(plan, [{ path: "evacuation.prepMinutes", value: "10" }], 2);
  assert.equal(evacuationSentence(plan, "隣の人"), "隣の人と車で、準備を入れて30分");
  assert.deepEqual(buildVillageRow({ plan, identity: {}, config, createdOn: "x" }), ["30"]);
});

test("CSV：ただの数字に印を付けず、数式には付ける", () => {
  assert.equal(toCsvText(["a"], ["-5"]).split(/\r?\n/)[1], "-5");
  assert.equal(toCsvText(["a"], ["+81"]).split(/\r?\n/)[1], "+81");
  assert.equal(toCsvText(["a"], ["=1+1"]).split(/\r?\n/)[1], "'=1+1");
  assert.equal(toCsvText(["a"], ["+1+cmd"]).split(/\r?\n/)[1], "'+1+cmd");
  assert.equal(toCsvText(["a"], ["-1+1"]).split(/\r?\n/)[1], "'-1+1");
});

test("次の一歩：埋まった話は残さない。問いかけの分は残す", () => {
  const plan = createPlan();
  plan.nextSteps.push({ topic: "place", text: "逃げるとしたら", fills: ["evacuation.place"] }, { topic: "neighbors", text: "ご近所", fills: ["helpers"] }, { topic: "y1-ask", text: "階段は" });
  const before = buildSummary(plan).next;
  assert.ok(before.includes("次に話す：逃げるとしたら") && before.includes("次に話す：ご近所"));
  applyUpdates(plan, [{ path: "evacuation.place", value: "公民館" }], 1);
  plan.helpers.push({ alias: "隣の人", asked: false });
  const after = buildSummary(plan).next;
  assert.ok(!after.includes("次に話す：逃げるとしたら") && !after.includes("次に話す：ご近所"));
  assert.ok(after.includes("次に話す：階段は"));
});

test("飛ばした問いかけは、点検で消えたら次の一歩に残さない", () => {
  const plan = createPlan();
  plan.nextSteps.push({ topic: "y1-ask", text: "階段は" });
  assert.ok(buildSummary(plan, [{ id: "y1-ask", text: "階段の話" }]).next.includes("次に話す：階段は"));
  assert.ok(!buildSummary(plan, [{ id: "y2-note", text: "別の話" }]).next.includes("次に話す：階段は"));
});
