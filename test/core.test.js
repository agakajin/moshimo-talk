import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeCsv, parseCsv } from "../src/core/csv.js";
import { normalizeAddress, normalizeDate, normalizeKana, normalizeName, normalizePhone, normalizePostal } from "../src/core/normalize.js";
import { findHeaderLeaks, classifyValue, maskTable } from "../src/core/mask.js";
import { parseWeekly, weekdaysWithoutService } from "../src/core/schedule.js";
import { findLeaks, redact } from "../src/core/redact.js";
import { importRow, serviceGaps } from "../src/core/plan.js";
import { fillsOfFinding } from "../src/core/talk.js";

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
    緊急連絡先氏名: "文字列6", 緊急連絡先TEL: "電話番号2", 歩行: "文字列7", 階段: "文字列8", 聞こえ: "文字列9", 普段の部屋: "文字列10", 寝室: "文字列11", 同居: "文字列12", 危険個所: "文字列13", 備考: undefined,
  });
});

test("備考は送らない", () => {
  const { payload } = maskTable(yoshikawa);
  const notes = payload.columns.find((c) => c.header === "備考");
  assert.equal(notes.withheld, true);
  assert.deepEqual(notes.samples, []);
});

test("見出しのない CSV の介護度や性別を、見出しの値として止める", () => {
  const { suspectHeaders } = maskTable({ headers: ["佐藤花子", "要介護1", "女"], rows: [["鈴木梅", "要介護2", "女"]] });
  assert.deepEqual(suspectHeaders, ["要介護1", "女"]);
});

test("週間予定：現場でよくある書き方を読む", () => {
  const days = (raw) => parseWeekly(raw).items.map((i) => `${i.days.join("")} ${i.kind} ${i.start}-${i.end}`);
  assert.deepEqual(days("月水金 通所介護 9:00-16:00"), ["月水金 通所介護 09:00-16:00"]);
  assert.deepEqual(days("月 通所介護 9:30～16:00／水 訪問介護（入浴介助）10:00～11:00"), ["月 通所介護 09:30-16:00", "水 訪問介護 10:00-11:00"]);
  assert.deepEqual(days("月:通所介護 9:00-16:00／土:訪問リハビリ 14:00-14:40"), ["月 通所介護 09:00-16:00", "土 訪問リハビリ 14:00-14:40"]);
  assert.deepEqual(days("月:通所介護 9時30分から16時"), ["月 通所介護 09:30-16:00"]);
  // 曜日の / は区切りと見ない。1件のまま読む
  assert.deepEqual(days("月/水/金 デイサービス 9:00-16:00"), ["月水金 デイサービス 09:00-16:00"]);
  // 休止や隔週の補足は外さず、読めない扱いにする
  for (const raw of ["月 デイサービス(入院中で停止) 9:00-16:00", "月 デイサービス(2週に1回) 9:00-16:00", "月(体験) デイサービス 9:00-16:00"]) assert.deepEqual(days(raw), [], raw);
  // 時間帯のあとに曜日が残る書き方は、黙って落とさず読めない扱いにする
  assert.deepEqual(parseWeekly("月 デイサービス 9:00-16:00 火/水 訪問介護 10:00-11:00").unread.some((u) => u.includes("火")), true);
  for (const raw of ["月 デイサービス 9:00-16:00(火も)", "月 デイサービス 9:00-16:00 送迎(火)"]) assert.deepEqual(days(raw), [], raw);
  // 補足の中に曜日があるものは読めない扱いのまま
  assert.deepEqual(days("通所介護(月水) 9:00-16:00"), []);
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

test("ふつうの言葉が見出しと重なっても、本物の値の漏れと見ない", () => {
  const table = {
    headers: ["服薬", "階段", "聴力", "認知症", "歩行状態", "weekly_services", "家族"],
    rows: [["服薬あり", "階段不可", "聴力低下", "認知症あり", "杖歩行", "Tue day service", "家族あり"]],
  };
  assert.deepEqual(findHeaderLeaks(table, maskTable(table).payload), []);
  const person = { headers: ["緊急連絡先", "家族構成", "キーパーソン", "本人の電話"], rows: [["家族", "夫婦", "本人", "000-0000-0001"]] };
  assert.deepEqual(findHeaderLeaks(person, maskTable(person).payload), []);
  const across = { headers: ["避難の必要性", "緊急の連絡", "入浴介助", "福祉用具利用", "訪問看護", "長男の連絡先"], rows: [["不要", "必要", "全介助", "車椅子利用", "かかりつけ看護師", "長男"]] };
  assert.deepEqual(findHeaderLeaks(across, maskTable(across).payload), []);
  const own = { headers: ["避難の必要性"], rows: [["必要"]] };
  assert.deepEqual(findHeaderLeaks(own, maskTable(own).payload), []);
});

test("見出しに残った名前は、どの列の値でも、名字だけでも見つける", () => {
  const cases = [
    [["氏名", "岡野さんの欄"], ["岡野 ハル", "なし"], "岡野 ハル"],
    [["フリガナ", "オカノ記入欄"], ["オカノ ハル", "なし"], "オカノ ハル"],
    [["緊急連絡先", "野田の続柄"], ["野田 修", "長男"], "野田 修"],
    // 名前の列に見えない見出しでも調べる
    [["世帯主", "岡野の備考"], ["岡野 ハル", "なし"], "岡野 ハル"],
    [["後見人", "岡野の備考"], ["岡野 ハル", "なし"], "岡野 ハル"],
    [["ふりがな", "おかのはるの備考"], ["おかの はる", "なし"], "おかの はる"],
    // 見出しの中で、ふつうの言葉と同じ字が姓名の境目をまたいでも見つける
    [["氏名", "麻生活男"], ["麻生 修", "なし"], "麻生 修"],
    [["氏名", "吉備考一"], ["吉備 修", "なし"], "吉備 修"],
    [["氏名", "諏訪問子"], ["諏訪 修", "なし"], "諏訪 修"],
    [["name", "HaradaYuki"], ["Harada Yuki", "none"], "Harada Yuki"],
    [["name", "Sadayo_memo"], ["Okano Sadayo", "none"], "Okano Sadayo"],
    // 名前の列に見えない列の値でも、途中の字で名前を壊さない
    [["協力者", "毛利の欄"], ["毛利用子", "なし"], "毛利用子"],
    [["毛利花子", "要介護1"], ["毛利用子", "要介護2"], "毛利用子"],
    [["協力者", "三男さんの欄"], ["鈴木三男", "なし"], "鈴木三男"],
    [["協力者", "訪問の欄"], ["訪問 花子", "なし"], "訪問 花子"],
    [["name", "Day_memo"], ["Doris Day", "none"], "Doris Day"],
    // 自分の列の見出しに入った名字、住所の一部、電話の下4桁
    [["氏名（岡野）", "要介護度"], ["岡野", "要介護1"], "岡野"],
    [["住所", "川上12-3の坂"], ["ハッカ村字川上12-3", "なし"], "ハッカ村字川上12-3"],
    [["電話", "1234の持ち主"], ["000-0000-1234", "なし"], "000-0000-1234"],
    [["緊急連絡先", "山田の欄"], ["長女・山田", "なし"], "長女・山田"],
    [["緊急連絡先", "山田の欄"], ["家族（山田）", "なし"], "家族（山田）"],
    // 名前の列の値は、ふつうの言葉を含んでいても除かない
    [["氏名", "訪問の欄"], ["訪問 花子", "なし"], "訪問 花子"],
    [["家族の氏名", "麻生の欄"], ["麻生活男", "なし"], "麻生活男"],
    // 見出しのない CSV の1行目に同じ名字が残っている
    [["岡野ハル", "要介護1"], ["岡野 修", "要介護2"], "岡野 修"],
    [["TEL", "000-0000-1234の持ち主"], ["000-0000-1234", "本人"], "000-0000-1234"],
  ];
  for (const [headers, row, want] of cases) {
    const table = { headers, rows: [row] };
    assert.deepEqual(findHeaderLeaks(table, maskTable(table).payload), [want], headers.join());
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
  assert.equal(out, "支援者1(隣の人)に電話。[電話番号] にかける。本人は夜いる");
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

test("耳打ちが埋める欄は、物差しから決まる", () => {
  const village = JSON.parse(readFileSync(new URL("../samples/hakka-village.config.json", import.meta.url)));
  assert.deepEqual(fillsOfFinding({ yardstick: "坂・階段・狭い道" }, village.yardsticks), ["evacuation.route", "evacuation.means"]);
  assert.deepEqual(fillsOfFinding({ yardstick: "持ち出し" }, village.yardsticks), ["carry"]);
  assert.deepEqual(fillsOfFinding({ yardstick: "様式の空き" }, village.yardsticks), []);
  assert.deepEqual(fillsOfFinding(null), []);
});
