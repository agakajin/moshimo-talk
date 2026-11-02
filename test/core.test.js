import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeCsv, parseCsv } from "../src/core/csv.js";
import { normalizeAddress, normalizeDate, normalizeKana, normalizeName, normalizePhone, normalizePostal } from "../src/core/normalize.js";
import { classifyValue, maskTable } from "../src/core/mask.js";
import { parseWeekly, weekdaysWithoutService } from "../src/core/schedule.js";
import { findLeaks, redact } from "../src/core/redact.js";
import { importRow, serviceGaps } from "../src/core/plan.js";

const load = (f) => parseCsv(decodeCsv(readFileSync(new URL(`../samples/${f}`, import.meta.url))));
const mapping = JSON.parse(readFileSync(new URL("../samples/keahakka.mapping.json", import.meta.url), "utf-8"));
const okano = load("keahakka_okano.csv");
const yoshikawa = load("keahakka_yoshikawa.csv");

test("Shift_JIS と BOM つき UTF-8 を読める", () => {
  assert.equal(okano.rows[0][0], "岡野 ハル");
  assert.equal(yoshikawa.headers[0], "利用者名");
  assert.equal(yoshikawa.rows[0][0], "𠮷川 正一");
});

test("引用符の中のカンマと改行を読める", () => {
  const { rows } = parseCsv('a,b\r\n"x,1","y\n2"\r\n');
  assert.deepEqual(rows[0], ["x,1", "y\n2"]);
});

test("日付をそろえる（元号の境目を含む）", () => {
  assert.equal(normalizeDate("昭和14年4月12日"), "1939-04-12");
  assert.equal(normalizeDate("1944/1/7"), "1944-01-07");
  assert.equal(normalizeDate("S14.04.12"), "1939-04-12");
  assert.equal(normalizeDate("昭和64年1月7日"), "1989-01-07");
  assert.equal(normalizeDate("昭和64年1月8日"), null);
  assert.equal(normalizeDate("平成元年1月8日"), "1989-01-08");
  assert.equal(normalizeDate("平成31年4月30日"), "2019-04-30");
  assert.equal(normalizeDate("平成31年5月1日"), null);
  assert.equal(normalizeDate("令和元年5月1日"), "2019-05-01");
  assert.equal(normalizeDate("2026/2/30"), null);
});

test("電話・郵便番号・ふりがな・住所をそろえる", () => {
  assert.equal(normalizePhone("（０００）００００－０００２"), "00000000002");
  assert.equal(normalizePostal("０００－０００１"), "0000001");
  assert.equal(normalizeKana("ｵｶﾉ ﾊﾙ"), "おかの はる");
  assert.equal(normalizeAddress("ハッカ村字ミドリ　１２０３ー５"), "ハッカ村字ミドリ 1203-5");
  assert.equal(normalizeAddress("ハッカ村字ミナト　２－３－４　村営みなと住宅２０１"), "ハッカ村字ミナト 2-3-4 村営みなと住宅201");
  assert.equal(normalizeAddress("名瀬1-2 ハッカ荘"), "名瀬1-2 ハッカ荘");
});

test("氏名の旧字・異体字を変えない", () => {
  assert.equal(normalizeName(" 𠮷川 正一 "), "𠮷川 正一");
  assert.equal(normalizeName("髙﨑 花"), "髙﨑 花");
});

test("値の形を判別する", () => {
  assert.equal(classifyValue("0000-00-1234"), "電話番号");
  assert.equal(classifyValue("０００－０００１"), "郵便番号");
  assert.equal(classifyValue("昭和14年4月12日"), "日付");
  assert.equal(classifyValue("ハッカ村字ミドリ　１２０３ー５"), "住所");
  assert.equal(classifyValue("岡野 ハル"), "文字列");
  assert.equal(classifyValue(""), "空");
});

test("岡野さんの CSV が台本どおりの記号になる", () => {
  const { payload } = maskTable(okano);
  const samples = Object.fromEntries(payload.columns.map((c) => [c.header, c.samples[0]]));
  assert.deepEqual(samples, {
    利用者名: "文字列1", ﾌﾘｶﾞﾅ: "文字列2", 生年月日: "日付1", 性別: "文字列3", "〒": "郵便番号1",
    住所: "住所1", 連絡先: "電話番号1", 介護度: "文字列4", 週間予定: "文字列5",
    緊急連絡先氏名: "文字列6", 緊急連絡先TEL: "電話番号2", 歩行: "文字列7", 備考: undefined,
  });
});

test("備考は送らない", () => {
  const { payload } = maskTable(yoshikawa);
  const notes = payload.columns.find((c) => c.header === "備考");
  assert.equal(notes.withheld, true);
  assert.deepEqual(notes.samples, []);
});

test("見出しに本物の値があれば止める", () => {
  const { suspectHeaders } = maskTable({ headers: ["岡野 ハル", "介護度"], rows: [["岡野 ハル", "要介護1"]] });
  assert.deepEqual(suspectHeaders, ["岡野 ハル"]);
});

test("Claude に送る中身に本物の値が入らない（両方のサンプル）", () => {
  for (const table of [okano, yoshikawa]) {
    const { payload } = maskTable(table);
    assert.deepEqual(findLeaks(payload, table.rows.flat()), []);
  }
});

test("漏れの検査は、混ざった値を本当に見つける", () => {
  assert.deepEqual(findLeaks({ memo: "岡野さんは坂の上" }, ["岡野 ハル"]), ["岡野 ハル"]);
  assert.deepEqual(findLeaks({ memo: "電話 000-0000-0001" }, ["000-0000-0001"]), ["000-0000-0001"]);
  assert.deepEqual(findLeaks({ memo: "電話 ００００００００００１" }, ["000-0000-0001"]), ["000-0000-0001"]);
  assert.deepEqual(findLeaks({ memo: "よしかわさん" }, ["ﾖｼｶﾜ ｼｮｳｲﾁ"]), ["ﾖｼｶﾜ ｼｮｳｲﾁ"]);
});

test("声メモの名前と電話番号を置き換える", () => {
  const known = [{ value: "野田 修", alias: "支援者1（隣の人）" }, { value: "𠮷川 正一", alias: "本人" }];
  const out = redact("野田さんに電話。000-0000-0003 にかける。𠮷川さんは夜いる", known);
  assert.equal(out, "支援者1(隣の人)さんに電話。[電話番号] にかける。本人さんは夜いる");
  assert.deepEqual(findLeaks(out, ["野田 修", "000-0000-0003", "𠮷川 正一"]), []);
});

test("週間予定から曜日と時間だけを取り出し、事業所名を捨てる", () => {
  const { items, unread } = parseWeekly("デイサービスはっか 月水金 9:00-16:00");
  assert.deepEqual(items, [{ kind: "デイサービス", days: ["月", "水", "金"], start: "09:00", end: "16:00" }]);
  assert.deepEqual(unread, []);
  assert.deepEqual(weekdaysWithoutService(items), ["火", "木"]);
  assert.ok(!JSON.stringify(items).includes("はっか"));
});

test("読めない予定は推測せず残す", () => {
  const { items, unread } = parseWeekly("週に何回か来てもらう");
  assert.deepEqual(items, []);
  assert.deepEqual(unread, ["週に何回か来てもらう"]);
});

test("岡野さんを取り込むと、分かる欄が埋まり火・木の穴が見える", () => {
  const { identity, plan, notes } = importRow({ headers: okano.headers, row: okano.rows[0], mapping });
  assert.equal(identity["self.birth"], "1939-04-12");
  assert.equal(identity["self.address"], "ハッカ村字ミドリ 1203-5");
  assert.equal(plan.care.level.value, "要介護1");
  assert.equal(plan.care.level.source, "csv");
  assert.equal(plan.evacuation.place.status, "undecided");
  assert.deepEqual(serviceGaps(plan), ["火", "木"]);
  assert.equal(notes, "娘さんはミント市在住");
  const secrets = [...Object.entries(identity).filter(([k]) => k !== "self.gender").map(([, v]) => v), notes];
  assert.deepEqual(findLeaks(plan, secrets), []);
});

test("𠮷川さんは列が足りなくても止まらず、氏名の字が変わらない", () => {
  const { identity, plan } = importRow({ headers: yoshikawa.headers, row: yoshikawa.rows[0], mapping });
  assert.equal(identity["self.name"], "𠮷川 正一");
  assert.equal(identity["self.kana"], "よしかわ しょういち");
  assert.equal(identity["self.phone"], "00000000002");
  assert.equal(plan.care.mobility.status, "undecided");
  assert.equal(plan.care.weekly.status, "undecided");
  assert.equal(serviceGaps(plan), null);
});
