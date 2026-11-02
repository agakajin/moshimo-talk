// レビューで見つかった入力を残す。意味が変わる置き換えと、すり抜ける形の両方
import { test } from "node:test";
import assert from "node:assert/strict";
import { findLeaks, personalKind, redact } from "../src/core/redact.js";
import { buildVillageRow, evacuationSentence } from "../src/core/output.js";
import { applyUpdates, createPlan, fieldsBefore, moveField, placedFields } from "../src/core/plan.js";
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

test("希望や返事待ちは「頼んだ」にしない", () => {
  for (const said of ["隣の人に頼みたい", "隣の人に頼みにくい", "隣の人に頼んだが断られた", "隣の人に頼んで返事待ち", "隣の人に頼んだことはない", "隣の人に頼んではいない", "隣の人にお願いしたい", "隣の人にお願いしようと思う", "隣の人が引き受けてくれるか分からない"]) {
    assert.equal(scribe([], [helper("隣の人", said, true)], said)[0].value.asked, false, said);
  }
  for (const said of ["隣の人に頼んだ", "隣の人に頼みました", "隣の人にお願いしてあります", "隣の人が引き受けてくれた"]) {
    assert.equal(scribe([], [helper("隣の人", said, true)], said)[0].value.asked, true, said);
  }
});

test("話に出ていない人は入れない。別の文の「頼んだ」も使わない", () => {
  assert.deepEqual(scribe([], [helper("息子さん", "娘に頼んだ", true)], "娘に頼んだ"), []);
  assert.deepEqual(scribe([], [helper("民生委員", "公民館に行く")], "公民館に行く"), []);
  const out = scribe([], [helper("隣の人", "隣の人がいる", true)], "隣の人がいる。娘には頼んだ");
  assert.equal(out[0].value.asked, false);
});

test("断られたと聞いたら頼んだを外す。人が決めたものは変えない", () => {
  const plan = createPlan();
  plan.helpers.push({ alias: "隣の人", asked: true, awayWeekdayDaytime: false });
  applyUpdates(plan, scribe([], [helper("隣の人", "隣の人に断られた")], "隣の人に断られた"), 1);
  assert.equal(plan.helpers[0].asked, false);
  assert.ok(!("declined" in plan.helpers[0]));
  Object.assign(plan.helpers[0], { asked: false, askedBy: "human" });
  applyUpdates(plan, scribe([], [helper("隣の人", "隣の人に頼んだ", true)], "隣の人に頼んだ"), 2);
  assert.equal(plan.helpers[0].asked, false);
});

test("置き換えの記号のまま計画に入れない", () => {
  assert.deepEqual(scribe([up("evacuation.place", "[お名前]さんの家", "[お名前]さんの家")], [], "[お名前]さんの家に逃げる"), []);
});

test("番地のない手元の住所でも、避難先の地名を残す", () => {
  const near = [{ value: "架空村川上", alias: "自宅", kind: "address" }];
  assert.equal(redact("川上の公民館へ逃げる", near), "川上の公民館へ逃げる");
  assert.equal(redact("架空村川上に住む", near), "自宅に住む");
  assert.deepEqual(findLeaks("川上小学校へ", [near[0]]), []);
});

test("ふつうの言葉を名前や住所にしない", () => {
  for (const text of ["T字杖で歩く", "T字杖1本で歩く", "十字路2つ目", "丁字路3本目", "薬ちゃんと飲む", "水くんでおく", "水様便", "仕様がない", "逆さま", "お向かいさんに頼む", "訪看さんが来る", "包括さん", "保健師さん", "相談員さん", "役場さん", "新聞屋さん", "隣おじさん", "平成30年7月3回避難した", "三丁目2軒目の公民館"]) {
    assert.equal(redact(text), text, text);
    assert.equal(personalKind(text), null, text);
  }
  assert.equal(redact("1番2番の順に回る", [{ value: "架空市本町1-2", alias: "自宅", kind: "address" }]), "1番2番の順に回る");
});

test("言葉の一覧を広げても、名字と番地はこれまでどおり置き換える", () => {
  for (const text of ["土屋さんが来る", "古屋さん", "雄士さん", "田中ちゃんが来る", "太郎くんが来る", "山田様の家"]) assert.match(redact(text), /\[お名前\]/, text);
  assert.match(redact("3丁目4番5号"), /\[住所\]/);
  assert.match(redact("昭和15年3月5日"), /\[日付\]/);
  assert.match(redact("昭和15年3月5"), /\[日付\]/);
});

function rowFor(setup) {
  const plan = createPlan();
  plan.consent = { contact: "no", care: "yes", evacuation: "yes", helper: "unasked" };
  plan.evacuation.prepMinutes = { status: "filled", value: "10" };
  plan.evacuation.moveMinutes = { status: "filled", value: "30" };
  setup(plan);
  const columns = ["避難場所", "ひとりになる時間帯", "避難時の配慮事項", "普段いる部屋", "避難方法"];
  const config = { alwaysColumns: columns, consentGroups: {}, columns, neverColumns: [], blankValue: "未定" };
  return buildVillageRow({ plan, identity: {}, config, createdOn: "2026-11-03" }).join("／");
}
const fill = (value) => ({ status: "filled", value });

test("同意がないときは、どの文の欄からも手伝う人を外す", () => {
  const row = rowFor((plan) => {
    plan.evacuation.place = fill("隣の人の家");
    plan.home.aloneHours = fill("娘が来ない平日の昼");
    plan.care.mobility = fill("娘が手を引けば杖で歩く");
    plan.home.usualRoom = fill("息子と同じ部屋");
    plan.evacuation.means = fill("長男の車");
  });
  assert.ok(!/隣|娘|息子|長男/.test(row), row);
  assert.match(row, /同意待ち/);
});

test("同意がなくても、人の話でない文はそのまま出す", () => {
  const row = rowFor((plan) => {
    plan.evacuation.place = fill("ハッカ村公民館");
    plan.evacuation.means = fill("手すりがあれば大丈夫");
    plan.considerations.items = fill("補聴器、水たくさん");
  });
  assert.ok(!/同意待ち/.test(row), row);
  assert.match(row, /手すりがあれば大丈夫/);
});

test("同意があれば、手伝う人の文も出す", () => {
  const row = rowFor((plan) => {
    plan.consent.helper = "yes";
    plan.evacuation.place = fill("隣の人の家");
  });
  assert.match(row, /隣の人の家/);
});

function moved() {
  const plan = createPlan();
  const updates = [{ path: "evacuation.route", value: "公民館" }];
  const before = fieldsBefore(plan, updates);
  applyUpdates(plan, updates, 1);
  return { plan, fresh: placedFields(plan, before, 1) };
}

test("声メモが入れた欄だけを、いま入った欄として返す", () => {
  const plan = createPlan();
  plan.evacuation.place = { status: "filled", value: "小学校", source: "human", memoId: null };
  const updates = [{ path: "evacuation.place", value: "公民館" }, { path: "carry", value: "薬" }, { path: "helpers.add", value: { alias: "隣の人", asked: false } }, { path: "hazards.noOthers", value: true }];
  const before = fieldsBefore(plan, updates);
  applyUpdates(plan, updates, 1);
  assert.deepEqual([...placedFields(plan, before, 1).keys()], ["carry"]);
});

test("別の欄へ移すと、元の欄は空に戻り、人が決めた値になる", () => {
  const { plan, fresh } = moved();
  const result = moveField(plan, "evacuation.route", "evacuation.place", { previous: fresh.get("evacuation.route") });
  assert.equal(result.moved, true);
  assert.equal(plan.evacuation.route.status, "undecided");
  assert.equal(plan.evacuation.route.value, null);
  assert.deepEqual([plan.evacuation.place.value, plan.evacuation.place.source], ["公民館", "human"]);
  // 移したあとは、次の声メモで上書きせず尋ねる
  const conflicts = applyUpdates(plan, [{ path: "evacuation.place", value: "小学校" }], 2);
  assert.equal(conflicts.length, 1);
  assert.equal(plan.evacuation.place.value, "公民館");
});

test("Claude が上書きした欄は、移すと前の値に戻る", () => {
  const plan = createPlan();
  applyUpdates(plan, [{ path: "evacuation.route", value: "坂道" }], 1);
  const updates = [{ path: "evacuation.route", value: "公民館" }];
  const before = fieldsBefore(plan, updates);
  applyUpdates(plan, updates, 2);
  const fresh = placedFields(plan, before, 2);
  moveField(plan, "evacuation.route", "evacuation.place", { previous: fresh.get("evacuation.route") });
  assert.equal(plan.evacuation.route.value, "坂道");
  assert.equal(plan.evacuation.route.source, "voice");
});

test("同じ話を2回入れていたら、移すと元の欄は空に戻る", () => {
  const plan = createPlan();
  applyUpdates(plan, [{ path: "evacuation.route", value: "公民館" }], 1);
  const updates = [{ path: "evacuation.route", value: "公民館" }];
  const before = fieldsBefore(plan, updates);
  applyUpdates(plan, updates, 2);
  moveField(plan, "evacuation.route", "evacuation.place", { previous: placedFields(plan, before, 2).get("evacuation.route") });
  assert.equal(plan.evacuation.route.value, null);
  assert.equal(plan.evacuation.place.value, "公民館");
});

test("行き先に別の値があれば、確かめるまで変えない", () => {
  const { plan, fresh } = moved();
  plan.evacuation.place = { status: "filled", value: "小学校", source: "human", memoId: null };
  const previous = fresh.get("evacuation.route");
  assert.deepEqual(moveField(plan, "evacuation.route", "evacuation.place", { previous }), { moved: false, reason: "occupied", current: "小学校" });
  assert.equal(plan.evacuation.route.value, "公民館");
  assert.equal(plan.evacuation.place.value, "小学校");
  assert.equal(moveField(plan, "evacuation.route", "evacuation.place", { previous, overwrite: true }).moved, true);
  assert.equal(plan.evacuation.place.value, "公民館");
});

test("時間として読めない文字は、分の欄へ移さない", () => {
  const { plan, fresh } = moved();
  assert.deepEqual(moveField(plan, "evacuation.route", "evacuation.moveMinutes", { previous: fresh.get("evacuation.route") }), { moved: false, reason: "minutes" });
  assert.equal(plan.evacuation.route.value, "公民館");
});

test("人が付けた「頼めた」の印を入口が断らない", () => {
  const plan = createPlan();
  plan.helpers.push({ alias: "隣の人", asked: true, askedBy: "human", awayWeekdayDaytime: false, memoId: null });
  assert.deepEqual(validateCheckPayload({ plan, gaps: null }), []);
});

test("「番」が続いても手元の住所を置き換える", () => {
  const home = [{ value: "架空市名瀬ミント町3-4", alias: "自宅", kind: "address" }];
  assert.equal(redact("名瀬ミント町3-4番", home), "自宅番");
  assert.equal(redact("川上12-3番", [ADDRESS]), "自宅番");
  assert.equal(redact("1番2番の順に回る", [{ value: "架空市本町1-2", alias: "自宅", kind: "address" }]), "1番2番の順に回る");
});

test("「ちゃんと」「くんで」でも、名前は置き換える", () => {
  for (const text of ["山田ちゃんと一緒に逃げる", "花子ちゃんと避難", "健太くんです", "健太くんだ", "健太くんで行く", "中坊さんが来る", "山田おじさんが来る"]) {
    assert.match(redact(text), /\[お名前\]/, text);
    assert.equal(personalKind(text), "名前", text);
  }
  for (const text of ["毎日ちゃんと飲む", "井戸水くんでおく", "お坊さんが来る"]) assert.equal(redact(text), text, text);
});

test("数字のない住所の書き方も置き換える。地名だけは残す", () => {
  for (const [value, said] of [["架空村川上三番", "川上三番に住む"], ["架空村川上百番五号", "川上百番五号に住む"], ["架空村東五丁目", "東五丁目に住む"], ["架空村川上ハイツ", "川上ハイツに住む"]]) {
    assert.equal(redact(said, [{ value, alias: "自宅", kind: "address" }]), "自宅に住む", said);
  }
  assert.equal(redact("一本松公民館へ", [{ value: "架空村一本松", alias: "自宅", kind: "address" }]), "一本松公民館へ");
});

test("否定、希望、うまくいかなかった話は「頼んだ」にしない", () => {
  for (const said of ["隣の人に頼んでいません", "隣の人に頼んでいなくて", "隣の人に頼んでいなかった", "隣の人にお願いしていません", "隣の人に頼んだことない", "隣の人が引き受けてくれなかった", "隣の人は引き受けてくれません", "隣の人に頼んだほうがいい", "隣の人に頼んだらいいと思う", "隣の人にお願いしたらどうか", "隣の人に頼んでいいか聞いてみる", "隣の人に引き受けてほしい", "隣の人に引き受けてもらいたい", "隣の人が引き受けてくれそう", "隣の人に頼めたらいい", "隣の人にお願いしたかった", "隣の人に頼んだけど無理と言われた"]) {
    assert.equal(scribe([], [helper("隣の人", said, true)], said)[0].value.asked, false, said);
  }
});

test("記号の入った呼び名を入れない", () => {
  assert.deepEqual(scribe([], [helper("[お名前]の隣の人", "[お名前]の隣の人")], "[お名前]の隣の人が来る"), []);
});

function peopleRow(setup, people) {
  const plan = createPlan();
  plan.consent = { contact: "no", care: "yes", evacuation: "yes", helper: "no" };
  plan.evacuation.prepMinutes = { status: "filled", value: "0" };
  plan.evacuation.moveMinutes = { status: "filled", value: "10" };
  setup(plan);
  const columns = ["避難場所", "自治会名", "自宅の災害リスク", "避難時の配慮事項", "普段いる部屋", "避難方法"];
  const config = { alwaysColumns: columns, consentGroups: {}, columns, neverColumns: [], blankValue: "未定" };
  return buildVillageRow({ plan, identity: {}, people, config, createdOn: "2026-11-03" }).join("／");
}

test("同意がないときは、入れた名前を名字だけでも隠す。すべての文の欄で", () => {
  const people = [{ name: "架空 花子", alias: "隣の人", phone: "" }];
  const row = peopleRow((plan) => {
    plan.evacuation.place = fill("架空の家");
    plan.evacuation.means = fill("架空花子の車");
    plan.considerations.items = fill("架空が手を引く");
    plan.hazards.items = fill("娘の家の裏が崖");
    plan.home.community = fill("区長は架空");
  }, people);
  assert.ok(!/架空|娘|区長/.test(row), row);
});

test("場所や体の言葉は、同意がなくても隠さない", () => {
  for (const place of ["隣町の小学校", "近所の公民館", "向かいの集会所", "親水公園", "台所の隣の部屋"]) {
    assert.match(peopleRow((plan) => { plan.evacuation.place = fill(place); }, []), new RegExp(place), place);
  }
  for (const walk of ["親指が痛い", "雨模様の日は歩けない"]) {
    assert.match(peopleRow((plan) => { plan.care.mobility = fill(walk); }, []), new RegExp(walk), walk);
  }
});

test("復唱の「行くんですね」を名前にしない", () => {
  for (const text of ["車いすで行くんですね", "歩くんですね", "杖で歩くんだ", "玄関に置くんですね", "動くんですか"]) {
    assert.equal(redact(text), text, text);
    assert.equal(personalKind(text), null, text);
  }
});
