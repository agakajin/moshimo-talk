// 週間予定の読み方。実データでよくある書き方を通す
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWeekly } from "../src/core/schedule.js";

const days = (raw) => parseWeekly(raw).items.map((i) => i.days.join(""));

test("曜日の区切りの違いを読む", () => {
  for (const raw of ["デイサービス 月水金 9:00-16:00", "デイサービスはつらつ 月・水・金 9:00～16:00", "デイサービス 月、水、金 9:00-16:00", "デイサービス 月曜 水曜 金曜 9:00-16:00", "デイサービス 月曜日・水曜日・金曜日 9時〜16時"]) {
    assert.deepEqual(days(raw), ["月水金"], raw);
  }
});

test("事業所の名前の字は曜日に数えない。範囲、平日、毎日も読む", () => {
  assert.deepEqual(days("日の出デイサービス 火 9:00-16:00"), ["火"]);
  assert.deepEqual(days("デイケア金峰 木 9:30-15:30"), ["木"]);
  assert.deepEqual(days("訪問介護 月〜金 10:00-11:00"), ["月火水木金"]);
  assert.deepEqual(days("訪問介護 平日 10:00-11:00"), ["月火水木金"]);
  assert.deepEqual(days("訪問介護 毎日 10:00-11:00"), ["月火水木金土日"]);
});

test("複数の予定と、読めないものを分ける", () => {
  const { items, unread } = parseWeekly("デイサービス 月水 9:00-16:00、訪問看護 金 14:00-15:00、よく分からない予定");
  assert.equal(items.length, 2);
  assert.deepEqual(unread, ["よく分からない予定"]);
  assert.equal(items[0].start, "09:00");
});

test("事業所の名前や言葉の字で曜日を増やさない", () => {
  assert.deepEqual(days("デイサービス三日月 火木 9:00-16:00"), ["火木"]);
  assert.deepEqual(days("デイサービス朝日 月水金 9:00-16:00"), ["月水金"]);
  assert.deepEqual(days("デイサービス春日 火木 9:00-16:00"), ["火木"]);
  assert.deepEqual(days("デイサービス月水金 9:00-16:00"), ["月水金"]);
  for (const raw of ["訪問看護 毎月 10:00-11:00", "ショートステイ 今月 9:00-16:00", "デイサービス旭日 9:00-16:00", "デイサービス三日月 9:00-16:00", "デイサービス 隔日 9:00-16:00", "デイサービス 祝日 9:00-16:00", "デイサービス 休日 9:00-16:00", "訪問介護 水曜を除く平日 9:00-10:00", "訪問介護 日曜除く毎日 9:00-10:00"]) {
    assert.deepEqual(parseWeekly(raw).items, [], raw);
    assert.equal(parseWeekly(raw).unread.length, 1, raw);
  }
});

test("範囲の言い方を読み、時間帯が2つの区切りは読めない扱いにする", () => {
  assert.deepEqual(days("訪問介護 月曜から金曜 10:00-11:00"), ["月火水木金"]);
  assert.deepEqual(days("訪問介護 月水〜金 10:00-11:00"), ["月水木金"]);
  const two = parseWeekly("デイサービス 月 9:00-12:00 水 13:00-16:00");
  assert.equal(two.items.length, 0);
  assert.equal(two.unread.length, 1);
});

test("毎週ではない言い方、休みや終わりの言い方は読まない", () => {
  for (const raw of ["デイサービス 第2火曜 9:00-16:00", "デイサービス 第2 火 9:00-16:00", "デイサービス 第1第3水曜 9:00-16:00", "デイサービス 隔週 水 9:00-16:00", "デイサービス 月2回 火 9:00-16:00", "デイサービス 週2回 月〜金 9:00-16:00", "デイサービス 月〜金 9:00-16:00(水曜を除く)", "デイサービス 月〜金 9:00-16:00 水曜除く", "デイサービス 水 9:00-16:00 休止中", "デイサービス 火 9:00-16:00 月2回", "デイサービス 火曜 9:00-16:00 第2週のみ", "デイサービス 水曜休み 平日 9:00-16:00", "(休止中)デイサービス 水 9:00-16:00", "デイサービス 3月で終了 火 9:00-16:00", "デイサービス 12月から 9:00-16:00", "デイサービス 4月〜 9:00-16:00", "ショートステイ 11月 9:00-16:00", "デイサービス 5日 水 9:00-16:00", "デイサービス 10日 9:00-16:00", "デイサービス 水 25:00-26:00", "デイサービス 水 16:00-9:00"]) {
    assert.deepEqual(parseWeekly(raw).items, [], raw);
    assert.equal(parseWeekly(raw).unread.length, 1, raw);
  }
});

test("事業所の名前の字を数えず、曜日の列を落とさない", () => {
  assert.deepEqual(days("デイサービスみか月 水 9:00-16:00"), ["水"]);
  assert.deepEqual(days("デイサービスみず木 火 9:00-16:00"), ["火"]);
  assert.deepEqual(days("デイサービスあさ日 水 9:00-16:00"), ["水"]);
  assert.deepEqual(days("デイサービス 毎週月・水 9:00-16:00"), ["月水"]);
  assert.deepEqual(days("訪問介護月・木 9:00-10:00"), ["月木"]);
  assert.deepEqual(days("デイサービス 毎週月水・金 9:00-16:00"), ["月水金"]);
  assert.deepEqual(days("デイサービス：月水金 9:00-16:00"), ["月水金"]);
  assert.deepEqual(days("訪問介護 月−金 9:00-10:00"), ["月火水木金"]);
  assert.deepEqual(days("訪問介護 月―金 9:00-10:00"), ["月火水木金"]);
  assert.deepEqual(days("訪問介護 月 9:00-10:00 はつらつ"), ["月"]);
  for (const raw of ["訪問介護 午前:月 午後:木 9:00-10:00", "訪問介護:月木 デイ:水 9:00-10:00"]) assert.deepEqual(parseWeekly(raw).items, [], raw);
});

test("「月-水-金」は読めない扱いにする", () => {
  for (const raw of ["デイサービス 月-水-金 9:00-16:00", "デイサービス 月ー水ー金 9:00-16:00", "デイサービス 月〜水〜金 9:00-16:00", "デイサービス 月−水−金 9:00-16:00", "デイサービス 月 - 水 - 金 9:00-16:00"]) {
    assert.deepEqual(parseWeekly(raw).items, [], raw);
  }
});
