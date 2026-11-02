// レビューで見つかった入力を残す。意味が変わる置き換えと、すり抜ける形の両方
import { test } from "node:test";
import assert from "node:assert/strict";
import { findLeaks, personalKind, redact } from "../src/core/redact.js";
import { buildVillageRow, evacuationSentence } from "../src/core/output.js";
import { createPlan } from "../src/core/plan.js";
import { acceptScribe } from "../src/server/claude.js";
import { validateCheckPayload } from "../src/server/validate.js";

const ADDRESS = { value: "架空村 字川上 12-3", alias: "自宅", kind: "address" };
const TOWN = { value: "架空市本町3-4", alias: "自宅", kind: "address" };

test("手元の字名や番地と同じ字の話は、意味を変えない", () => {
  assert.equal(redact("川上の公民館へ逃げる", [ADDRESS]), "川上の公民館へ逃げる");
  assert.equal(redact("川上橋を渡る", [ADDRESS]), "川上橋を渡る");
  assert.equal(redact("準備に3-4分かかる", [TOWN]), "準備に3-4分かかる");
  assert.equal(redact("3-4人で行く", [TOWN]), "3-4人で行く");
});

test("住所を言ったときは、これまでどおり置き換える", () => {
  assert.equal(redact("字川上12-3に住んでいる", [ADDRESS]), "自宅に住んでいる");
  assert.ok(!/川上12/.test(redact("川上12-3です", [ADDRESS])));
  assert.ok(!/本町3-4/.test(redact("本町3-4です", [TOWN])));
});

test("短い読みと地名は、ふつうの言葉を壊さない", () => {
  const hajime = [{ value: "はじめ", alias: "本人" }];
  assert.equal(redact("はじめに2階へ上がる", hajime), "はじめに2階へ上がる");
  const nakano = [{ value: "なかの まもる", alias: "本人" }];
  assert.equal(redact("おなかの調子が悪い", nakano), "おなかの調子が悪い");
  assert.equal(redact("自分の身をまもる", nakano), "自分の身をまもる");
  assert.equal(redact("平和台公民館へ", [{ value: "平和 太郎", alias: "緊急連絡先" }]), "平和台公民館へ");
  assert.ok(!/なかの/.test(redact("なかのさんが来る", nakano)));
  assert.ok(!/なかのまもる/.test(redact("なかのまもるです", nakano)));
});

test("漢字の名字だけは、言葉と重なっても約束を優先して置き換える", () => {
  assert.equal(redact("大橋が手伝う", [{ value: "大橋 はじめ", alias: "本人" }]), "本人が手伝う");
});

test("続き柄や職業の「さん」、様子やたくさんを名前にしない", () => {
  for (const text of ["平日娘さんが来ます", "毎朝奥さんが", "甥っ子さん", "左隣さん", "隣のお婆さんが来る", "歯医者さんに行く", "薬剤師さん", "訪問看護さんが来る", "デイさんの車", "組長さん", "管理人さんに聞く", "お客さんが来る", "足が悪い様子", "歩く様子を見る", "同じ様に避難", "水たくさん持つ", "お疲れさま", "摂氏30度", "点字ブロック3枚", "三丁目の公民館"]) {
    assert.equal(personalKind(text), null, text);
    assert.equal(redact(text), text, text);
  }
});

test("名前と番地は、これまでどおり置き換える", () => {
  assert.equal(redact("田中さんが来る"), "[お名前]さんが来る");
  assert.equal(redact("和夫さんが来る"), "[お名前]さんが来る");
  assert.equal(redact("直人さんが来る"), "[お名前]さんが来る");
  assert.equal(redact("山田様の家"), "[お名前]様の家");
  assert.match(redact("3丁目4-5です"), /\[住所\]/);
  assert.match(redact("12番地です"), /\[住所\]/);
});

test("電話番号のすり抜ける形を止める", () => {
  for (const text of ["000 - 0000 - 0000", "000:0000:0000", "000~0000~0000", "0 0 0 0 0 0 0 0 0 0 0", "000 0000​0000", "+81-90-0000-0000"]) {
    assert.equal(personalKind(text), "電話番号", text);
    assert.match(redact(text), /\[電話番号\]/, text);
  }
});

test("生年月日のすり抜ける形を止める", () => {
  for (const text of ["19400305", "s15.3.5", "昭15年3月5日生まれ", "昭和15年生まれ", "昭和15年3月に生まれ", "生年月日は15年3月5日"]) {
    assert.equal(personalKind(text), "日付", text);
    assert.match(redact(text), /\[日付\]/, text);
  }
});

test("ふつうの数字と災害の年月は止めない", () => {
  for (const text of ["台風10号", "国道58号", "平成30年7月の大雨", "令和2年7月豪雨", "0.5錠を1日2回", "血圧140-90", "9時-17時", "準備に15分", "公民館まで10-15分"]) {
    assert.equal(personalKind(text), null, text);
  }
});

test("redact が残した地名で、送信を止めない", () => {
  assert.deepEqual(findLeaks("架空村の避難所へ行く", [ADDRESS]), []);
  assert.deepEqual(findLeaks("平和台公民館へ", ["平和 太郎"]), []);
  assert.deepEqual(findLeaks("字川上12-3です", [ADDRESS]), [ADDRESS.value]);
  assert.deepEqual(findLeaks("平和が手伝う", ["平和 太郎"]), ["平和 太郎"]);
});

function noConsent(extra) {
  const plan = createPlan();
  plan.consent.helper = "no";
  plan.helpers.push({ alias: "隣の人", asked: true, awayWeekdayDaytime: false });
  plan.evacuation.prepMinutes = { status: "filled", value: "10" };
  plan.evacuation.moveMinutes = { status: "filled", value: "30" };
  Object.assign(plan.evacuation, extra.evacuation);
  if (extra.items) plan.considerations.items = { status: "filled", value: extra.items };
  return plan;
}

test("同意がないときは、手段に手伝う人を出さない", () => {
  const plan = noConsent({ evacuation: { means: { status: "filled", value: "隣の親子の車" } } });
  const sentence = evacuationSentence(plan, null);
  assert.ok(!/隣/.test(sentence), sentence);
  assert.match(sentence, /同意待ち/);
  assert.match(sentence, /40分/);
  const plain = noConsent({ evacuation: { means: { status: "filled", value: "車いす" } } });
  assert.equal(evacuationSentence(plain, null), "車いすで、準備を入れて40分");
});

test("同意がないときは、配慮事項に手伝う人を出さない", () => {
  const plan = noConsent({ evacuation: {}, items: "補聴器、隣の人に手を引いてもらう" });
  const config = { alwaysColumns: ["避難時の配慮事項"], consentGroups: {}, columns: ["避難時の配慮事項"], neverColumns: [], blankValue: "未定" };
  const row = JSON.stringify(buildVillageRow({ plan, identity: {}, config, createdOn: "2026-11-03" }));
  assert.ok(!/隣/.test(row), row);
});

const scribe = (updates, helpers, memo) => acceptScribe({ updates, helpers }, memo);
const up = (path, value, quote) => ({ path, value, quote });
const helper = (alias, quote, asked = false) => ({ alias, asked, awayWeekdayDaytime: false, quote });

test("問いかけは根拠にしない。「か」を抜いた引用でも通さない", () => {
  assert.deepEqual(scribe([up("hazards.noOthers", "true", "ほかに心配な災害はありません")], [], "ほかに心配な災害はありませんか"), []);
  assert.deepEqual(scribe([up("evacuation.place", "公民館", "公民館")], [], "公民館に行かれますか"), []);
  assert.deepEqual(scribe([up("evacuation.moveMinutes", "30", "30分")], [], "30分で行けますか"), []);
  assert.deepEqual(scribe([], [helper("隣の方", "隣の方")], "隣の方はいらっしゃいますか"), []);
});

test("復唱の言い方は内容として通す", () => {
  assert.equal(scribe([up("home.bedroom", "裏の部屋", "裏の部屋でお休みなんですね")], [], "裏の部屋でお休みなんですね").length, 1);
  assert.equal(scribe([up("evacuation.place", "公民館", "公民館")], [], "逃げるなら公民館、ということでよろしいですね").length, 1);
});

test("頼んだかどうかは、その人の文で確かめる", () => {
  const out = scribe([], [helper("娘さん", "娘さんに頼んであるんですね", true), helper("隣の人", "隣の人にはまだなんですね", true)], "娘さんに頼んであるんですね。隣の人にはまだなんですね");
  assert.deepEqual(out.map((u) => u.value.asked), [true, false]);
  for (const said of ["隣の人に頼んでみるつもりなんですね", "隣の人にはお願いしてないんですね"]) {
    assert.equal(scribe([], [helper("隣の人", said, true)], said)[0].value.asked, false, said);
  }
});

test("名字らしい呼び名は一般の呼び方にし、別の人を1人に畳まない", () => {
  const memo = "佐藤の人とポチとタマが来る";
  const out = scribe([], [helper("佐藤の人", "佐藤の人"), helper("ポチ", "ポチ"), helper("タマ", "タマ")], memo);
  assert.deepEqual(out.map((u) => u.value.alias), ["近くの人", "近くの人2", "近くの人3"]);
});

test("入口：項目の名前、数字、1字ずつの配列、知らない項目を断る", () => {
  const plan = (care) => ({ plan: { care }, gaps: null });
  assert.notDeepEqual(validateCheckPayload(plan({ "000-0000-0000": { status: "filled", value: "x" } })), []);
  assert.notDeepEqual(validateCheckPayload(plan({ level: { status: "filled", value: 9000000000 } })), []);
  assert.notDeepEqual(validateCheckPayload({ plan: { hazards: { items: { status: "filled", value: [..."00000000000"] } } }, gaps: null }), []);
  assert.notDeepEqual(validateCheckPayload(plan({ extra: "自由" })), []);
  assert.deepEqual(validateCheckPayload(plan({ level: { status: "filled", value: "要介護1" } })), []);
});
