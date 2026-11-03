// 読み取り専用のレビュー役が見つけた破れ方を、二度と起こさないために残す。値はすべて架空
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { maskTable } from "../src/core/mask.js";
import { applyUpdates, createPlan, importRow, planForClaude } from "../src/core/plan.js";
import { buildVillageRow, toCsvText, totalMinutes } from "../src/core/output.js";
import { findLeaks, personalKind, redact, redactDeep } from "../src/core/redact.js";
import { validateCheckPayload, validateColumnsPayload, validateScribePayload } from "../src/server/validate.js";
import { acceptFindings, acceptScribe, timeFinding } from "../src/server/claude.js";
import { COMMON_YARDSTICKS } from "../src/server/prompts.js";

const KNOWN = [
  { value: "山田 花子", alias: "本人" },
  { value: "やまだ はなこ", alias: "本人" },
  { value: "ハッカ村字山田12-3", alias: "自宅", kind: "address" },
];

test("生年月日の形は、手元に無くても置き換える", () => {
  for (const memo of ["昭和10年5月3日生まれ", "1935年5月3日", "S10.5.3", "昭和十年五月三日", "昭和10年の5月3日", "1935年の5月3日"]) {
    assert.match(redact(memo), /\[日付\]/, memo);
  }
  assert.equal(redact("準備に15分、公民館まで30分"), "準備に15分、公民館まで30分");
  assert.equal(redact("デイは9:00-16:00"), "デイは9:00-16:00");
});

test("カタカナや半角の名前も、手元の名前なら置き換える", () => {
  for (const memo of ["ヤマダさんは", "ﾔﾏﾀﾞさんは", "ハナコさんは", "やまださんは"]) {
    assert.ok(!/ヤマダ|ハナコ|やまだ/.test(redact(memo, KNOWN)), memo);
  }
});

test("手元に無い名前も「さん」が付けば置き換え、続き柄は残す", () => {
  assert.equal(redact("隣の田中和子さんに頼む"), "隣の[お名前]さんに頼む");
  assert.equal(redact("林さんは"), "[お名前]さんは");
  for (const memo of ["娘さんに電話", "隣の人に頼む", "お隣さんと話す", "ケアマネさんが来る", "民生委員さんが来る"]) {
    assert.equal(redact(memo), memo);
  }
});

test("手元の番号は下の桁だけを話しても置き換える。ほかの数字は残す", () => {
  const known = [{ value: "0000-52-1234", alias: "[電話番号]", kind: "phone" }];
  assert.equal(redact("52-1234に電話", known), "[電話番号]に電話");
  assert.equal(redact("避難所まで500-1000メートル"), "避難所まで500-1000メートル");
});

test("区切りが違う電話番号も置き換える", () => {
  for (const memo of ["０００－１２３４－５６７８", "000ー1234ー5678", "000−1234−5678", "000.1234.5678", "000の1234の5678", "〇〇〇ー一二三四ー五六七八", "000,1234,5678", "000、1234、5678", "000/1234/5678", "000_1234_5678", "000の一二三四の5678"]) {
    assert.match(redact(memo), /\[電話番号\]/, memo);
    assert.equal(personalKind(memo), "電話番号", memo);
  }
});

test("名字と地名が重なっても、住所を壊さず置き換える。一部だけ話しても置き換える", () => {
  assert.equal(redact("ハッカ村字山田12-3", KNOWN), "自宅");
  assert.equal(redact("字山田12の3", KNOWN), "自宅");
  assert.equal(redact("山田の家", KNOWN), "本人の家");
  assert.equal(redact("字山田12-3に住む", KNOWN), "自宅に住む");
  assert.equal(redact("字山田12番地3に住む", KNOWN), "自宅に住む");
});

test("手で直した欄も、送るときは置き換える", () => {
  const plan = createPlan();
  plan.home.community.value = "田中和子さん宅 ０００－１２３４－５６７８";
  const sent = JSON.stringify(redactDeep(plan, KNOWN));
  assert.ok(!/田中|１２３４|1234/.test(sent));
  assert.equal(redactDeep(plan, KNOWN).care.level.status, "undecided");
});

test("サーバーの入口は、番号・日付・住所・名前の形と、知らない項目を止める", () => {
  const plan = createPlan();
  for (const value of ["０００－１２３４－５６７８", "000ー1234ー5678", "000\n1234\n5678", "昭和10年5月3日", "〒000-0006", "ハッカ村字山田12-3", "田中和子さん"]) {
    plan.home.community.value = value;
    assert.ok(validateCheckPayload({ plan, gaps: null }).length > 0, value);
  }
  plan.home.community.value = "ハッカ村第一自治会";
  assert.deepEqual(validateCheckPayload({ plan, gaps: ["火", "木"] }), []);
  assert.ok(validateCheckPayload({ plan: { ...plan, identity: { name: "x" } }, gaps: null }).length > 0);
  assert.ok(validateCheckPayload({ plan, gaps: "山田花子" }).length > 0);
  assert.ok(validateCheckPayload({ plan: { ...plan, helpers: [{ alias: "隣の人", name: "x" }] }, gaps: null }).length > 0);
  assert.ok(validateScribePayload({ memo: "昭和10年5月3日生まれ", plan }).length > 0);
});

test("見出しの無い CSV や、見出しに混ざった値を止める", () => {
  const headers = ["山田 花子", "やまだ はなこ", "昭和10年5月3日", "ハッカ村字山田12-3", "000-1234-5678"];
  const { payload, suspectHeaders } = maskTable({ headers, rows: [["田中 和子", "たなか かずこ", "昭和11年1月2日", "ハッカ村字川1-1", "000-0000-0001"]] });
  assert.ok(suspectHeaders.length >= 3);
  assert.ok(validateColumnsPayload(payload).length > 0);
  const mixed = maskTable({ headers: ["緊急連絡先(000-1234-5678)", "介護度"], rows: [["平井", "要介護1"]] });
  assert.deepEqual(mixed.suspectHeaders, ["緊急連絡先(000-1234-5678)"]);
  assert.ok(validateColumnsPayload(mixed.payload).length > 0);
  const normal = maskTable({ headers: ["利用者名", "緊急連絡先 氏名", "〒", "生年月日"], rows: [["平井", "平井", "000-0001", "昭和10年5月3日"]] });
  assert.deepEqual(normal.suspectHeaders, []);
  assert.deepEqual(validateColumnsPayload(normal.payload), []);
});

test("CSV の文の列は計画に元のまま残し、送る前に住所と名前を置き換える", () => {
  const headers = ["氏名", "住所", "危険", "介護度"];
  const row = ["山田 花子", "ハッカ村字川5-3", "字川5番地3の裏は崖", "山田 花子"];
  const { plan } = importRow({ headers, row, mapping: { 氏名: "self.name", 住所: "self.address", 危険: "home.hazardNote", 介護度: "care.level" } });
  assert.equal(plan.home.hazardNote.value, "字川5番地3の裏は崖");
  const known = [{ value: "山田 花子", alias: "本人" }, { value: "ハッカ村字川5-3", alias: "自宅", kind: "address" }];
  const sent = JSON.stringify(redactDeep(planForClaude(plan), known));
  assert.ok(!/字川|5番地/.test(sent), sent);
  assert.ok(!/山田/.test(sent), sent);
});

test("書き取り：値がメモと結びつかなければ捨てる", () => {
  const memo = "公民館。隣の人に頼んだ。薬は袋に";
  const u = (path, value, quote) => ({ path, value, quote });
  const out = acceptScribe({
    updates: [
      u("evacuation.place", "ハッカ総合病院", "公民館"),
      u("home.community", "山田花子", "の"),
      u("considerations.items", "血圧の薬をやめて様子を見る", "薬は袋に"),
      u("considerations.items", "酸素をやめる", "薬は袋に"),
      u("evacuation.moveMinutes", "5", "袋に"),
      u("contactMeans", "０００－１２３４－５６７８", "袋に"),
      u("hazards.noOthers", "true", "公民館"),
      u("carry", "薬（袋）", "薬は袋に"),
      u("evacuation.place", "公民館", "公民館"),
    ],
    helpers: [
      { alias: "田中和子さん", awayWeekdayDaytime: false, asked: true, quote: "隣の人に" },
      { alias: "隣の人", awayWeekdayDaytime: false, asked: true, quote: "隣の人に頼んだ" },
    ],
  }, memo);
  assert.deepEqual(out, [
    { path: "carry", value: "薬（袋）" },
    { path: "evacuation.place", value: "公民館" },
    { path: "helpers.add", value: { alias: "隣の人", awayWeekdayDaytime: false, asked: true } },
  ]);
});

test("書き取り：「頼んでいない」は頼んだことにしない。時間の換算は通す", () => {
  const [helper] = acceptScribe({ updates: [], helpers: [{ alias: "隣の人", awayWeekdayDaytime: false, asked: true, quote: "隣の人" }] }, "隣の人にはまだ頼んでいない");
  assert.equal(helper.value.asked, false);
  const out = acceptScribe({ updates: [{ path: "evacuation.moveMinutes", value: "60", quote: "1時間" }] , helpers: [] }, "神社まで1時間");
  assert.deepEqual(out, [{ path: "evacuation.moveMinutes", value: "60" }]);
  const u = (value, quote) => ({ path: "evacuation.moveMinutes", value, quote });
  const minutes = (update, memo) => acceptScribe({ updates: [update], helpers: [] }, memo).map((x) => x.value);
  assert.deepEqual(minutes(u("30", "三十分"), "公民館まで三十分"), ["30"]);
  assert.deepEqual(minutes(u("約30", "30分くらい"), "公民館まで30分くらい"), ["30"]);
  assert.deepEqual(minutes(u("120", "時間がかかる"), "準備に時間がかかる"), []);
  assert.deepEqual(minutes(u("2", "12分"), "移動に12分"), []);
});

test("点検：医療の判断、約束、連絡の話を残さない", () => {
  const f = (o) => ({ yardstick: "一本足", text: "知らせの手段が1つです。", interrupt: false, opener: null, request: null, ...o });
  for (const text of ["薬を飲まなくてもよいです", "血圧の薬は減らせそうです", "お薬を控えましょう", "服用をやめましょう", "糖尿病が悪化しそうです", "認知症が疑われます", "病院で診てもらいましょう", "医師に相談を", "隣の人が必ず迎えに来ます", "娘さんに今すぐ連絡します"]) {
    assert.deepEqual(acceptFindings([f({ text })], COMMON_YARDSTICKS), [], text);
  }
  for (const request of ["絶対に迎えに来てください", "雨の夜は毎回、隣の人が迎えに行きます", "娘さんに今すぐ連絡します"]) {
    assert.ok(!("request" in acceptFindings([f({ request })], COMMON_YARDSTICKS)[0]), request);
  }
  assert.equal(acceptFindings([f({ yardstick: "持ち出し", text: "薬を持って出る段取りをまだ聞けていません。" })], COMMON_YARDSTICKS).length, 1);
  assert.equal(acceptFindings([f({ request: "雨の夜に、電話を1本" })], COMMON_YARDSTICKS)[0].request, "雨の夜に、電話を1本");
});

test("CSV から来た欄を、声メモが黙って上書きしない", () => {
  const { plan } = importRow({ headers: ["寝室"], row: ["2階"], mapping: { 寝室: "home.bedroom" } });
  const conflicts = applyUpdates(plan, [{ path: "home.bedroom", value: "1階" }], 1);
  assert.equal(plan.home.bedroom.value, "2階");
  assert.equal(conflicts[0].proposed, "1階");
});

const CONFIG = { columns: ["避難方法", "避難支援者1続柄"], alwaysColumns: [], neverColumns: [], blankValue: "未決定", consentGroups: { evacuation: { columns: ["避難方法"] }, helper: { columns: ["避難支援者1続柄"] } } };
function planWithHelper(helperConsent) {
  const plan = createPlan();
  applyUpdates(plan, [{ path: "evacuation.means", value: "車いす" }, { path: "evacuation.prepMinutes", value: "15" }, { path: "evacuation.moveMinutes", value: "30" }], 1);
  plan.helpers.push({ alias: "隣の田中さん", asked: true });
  plan.consent.evacuation = "yes";
  plan.consent.helper = helperConsent;
  return plan;
}

test("手伝う人を断ったら、呼び名は避難方法にも出ない", () => {
  const refused = buildVillageRow({ plan: planWithHelper("no"), identity: {}, config: CONFIG, createdOn: "2026-11-02" });
  assert.equal(refused[0], "車いすで、準備を入れて45分");
  const agreed = buildVillageRow({ plan: planWithHelper("yes"), identity: {}, config: CONFIG, createdOn: "2026-11-02" });
  assert.match(agreed[0], /^隣の田中さんと車いす/);
});

test("CSV の数式は、空白や全角で隠れていても動かないようにする", () => {
  for (const cell of [" =1+1", "\n=1+1", "＝1+1", "=1+1"]) {
    const line = toCsvText(["欄"], [cell]).split("\r\n").slice(1).join("\r\n");
    assert.match(line, /^"?'/, JSON.stringify(cell));
  }
  assert.ok(!toCsvText(["欄"], ["000-0000-0001"]).includes("'"));
});

test("おかしな URL でサーバーが落ちない", async (t) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../server.mjs", import.meta.url))], { env: { ...process.env, ANTHROPIC_API_KEY: "", APP_PASSWORD: "", HOST: "127.0.0.1", PORT: "0" } });
  t.after(() => child.kill());
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /localhost:(\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  await new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => socket.write("GET // HTTP/1.1\r\nHost: x\r\n\r\n"));
    socket.on("data", () => socket.destroy());
    socket.on("close", resolve);
    socket.on("error", resolve);
  });
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
});

// 二度目のレビューで分かった、検査の強すぎ。ふつうの話を止めたり壊したりしない
const EVERYDAY = [
  "村の公民館まで10-15分", "ハッカ村小学校まで20-30分", "坂道を5-10分歩く", "鹿児島市の息子さんが月2-3回来る", "奄美市に住む娘が週に1-2回来る",
  "村の人が2-3人来る", "町内の人が3-4人", "地区の集まりは7-8時", "都合で2-3日いない", "町のデイサービス9:00-16:00", "県道12-3号が崩れる",
  "避難所まで500-1000メートル", "昼は1200-1300に食事", "1・3・5・7・9・11・13日に来る", "平成30年7月の大雨", "2011年3月の津波",
  "長男さんが来る", "次女さんに頼む", "皆さんと逃げる", "猫ちゃんも一緒", "赤ちゃんがいる", "雨模様のとき", "同様に心配", "町内会長さんに話す", "訪問看護師さんが来る", "市役所さんから電話", "デイサービスさんの送迎",
  "ケアマネジャーさんが来る", "お隣さん", "隣のおじさん", "公民館", "要介護2", "80歳",
];

test("ふつうの話は、置き換えず、入口でも止めない", () => {
  for (const memo of EVERYDAY) {
    assert.equal(redact(memo), memo);
    assert.equal(personalKind(memo), null, memo);
  }
});

test("読みの短い名前や住所の一部が、ふつうの言葉を壊さない", () => {
  const cases = [
    [[{ value: "おかの とき", alias: "本人" }], "雨のときは、ときどき、いとこに電話する"],
    [[{ value: "おかの みち", alias: "本人" }], "みちが狭い"],
    [[{ value: "おかの こと", alias: "本人" }], "心配なことはない"],
    [[{ value: "おかの はな", alias: "本人" }], "はなれた小学校へ"],
    [[{ value: "ハッカ村 坂下 12-3", alias: "自宅", kind: "address" }], "ハッカ村小学校へ行く"],
    [[{ value: "ハッカ村字坂下2-3", alias: "自宅", kind: "address" }], "公民館まで2-3分"],
  ];
  for (const [known, memo] of cases) assert.equal(redact(memo, known), memo);
  assert.equal(redact("ときさんに聞く", [{ value: "おかの とき", alias: "本人" }]), "本人に聞く");
  assert.equal(redact("田中さんに電話を頼む", [{ value: "田中", alias: "隣の人" }]), "隣の人に電話を頼む");
});

test("字体が違っても、手元の名前を置き換え、漏れの検査も見つける", () => {
  assert.equal(redact("高橋一郎の娘", [{ value: "髙橋 一郎", alias: "本人" }]), "本人の娘");
  assert.equal(redact("吉川正一は階段が", [{ value: "𠮷川 正一", alias: "本人" }]), "本人は階段が");
  assert.equal(redact("斎藤の家", [{ value: "齋藤 花子", alias: "本人" }]), "本人の家");
  assert.deepEqual(findLeaks("高橋一郎", ["髙橋 一郎"]), ["髙橋 一郎"]);
  assert.equal(redact("山﨑さんに聞く"), "[お名前]さんに聞く");
  assert.equal(redact("田中みちさんに聞く"), "[お名前]さんに聞く");
});

test("漏れの検査は、離れた数字をつなげて誤検知しない", () => {
  assert.deepEqual(findLeaks("予定 10:00-16:00", ["1000160"]), []);
  assert.deepEqual(findLeaks("000-0000-0001", ["00000000001"]), ["00000000001"]);
});

test("よくある CSV の見出しで止まらない", () => {
  const headers = ["利用者氏名", "被保険者氏名", "主治医氏名", "利用者様", "地区1", "区分1", "町名2", "歩行 状態", "週間 予定", "認定 区分", "同居", "歩行"];
  const { suspectHeaders, payload } = maskTable({ headers, rows: [headers.map((h) => (h === "同居" || h === "歩行" ? h : "あ"))] });
  assert.deepEqual(suspectHeaders, []);
  assert.deepEqual(validateColumnsPayload(payload), []);
  assert.ok(maskTable({ headers: ["日高 太郎"], rows: [["x"]] }).suspectHeaders.length === 1);
});

test("書き取り：事実の記録と言い換えを捨てない。指図だけ止める", () => {
  const take = (path, value, memo) => acceptScribe({ updates: [{ path, value, quote: memo }], helpers: [] }, memo).map((x) => x.value);
  assert.deepEqual(take("carry", "薬と飲み水", "薬と飲み水を持つ"), ["薬と飲み水"]);
  assert.deepEqual(take("considerations.items", "認知症で夜に歩く", "認知症で夜に歩く"), ["認知症で夜に歩く"]);
  assert.deepEqual(take("timeBands", "火曜は看護師さんが診てくれる", "火曜は看護師さんが診てくれる"), ["火曜は看護師さんが診てくれる"]);
  assert.deepEqual(take("evacuation.means", "徒歩", "歩いて行く"), ["徒歩"]);
  assert.deepEqual(take("contactMeans", "固定電話のみ", "家の電話しかない"), ["固定電話のみ"]);
  const before = { carry: { value: "常備薬と懐中電灯と着替え", status: "filled" } };
  assert.deepEqual(acceptScribe({ updates: [{ path: "carry", value: "常備薬と懐中電灯と着替えと通帳", quote: "通帳も持つ" }], helpers: [] }, "通帳も持つ", [], before).map((x) => x.value), ["常備薬と懐中電灯と着替えと通帳"]);
  assert.deepEqual(take("considerations.items", "酸素をやめる", "酸素をやめると書いて"), []);
  assert.deepEqual(take("hazards.noOthers", "true", "ほかの災害は心配していません"), [true]);
  const [helper] = acceptScribe({ updates: [], helpers: [{ alias: "隣の人", awayWeekdayDaytime: false, asked: true, quote: "隣の人に頼みました" }] }, "隣の人に頼みました");
  assert.equal(helper.value.asked, true);
  const [named] = acceptScribe({ updates: [], helpers: [{ alias: "田中", awayWeekdayDaytime: false, asked: false, quote: "田中が手伝う" }] }, "田中が手伝う");
  assert.equal(named.value.alias, "近くの人");
});

test("あとから「頼んだ」と聞いたら直し、やり直しのメモは新しい話を消さない", () => {
  const plan = createPlan();
  applyUpdates(plan, [{ path: "helpers.add", value: { alias: "隣の人", asked: false } }], 1);
  applyUpdates(plan, [{ path: "helpers.add", value: { alias: "隣の人", asked: true } }], 2);
  assert.equal(plan.helpers[0].asked, true);
  applyUpdates(plan, [{ path: "evacuation.place", value: "小学校" }], 3);
  const conflicts = applyUpdates(plan, [{ path: "evacuation.place", value: "公民館" }], 4, { late: true });
  assert.equal(plan.evacuation.place.value, "小学校");
  assert.equal(conflicts[0].proposed, "公民館");
});

test("時間は全角・漢数字・単位つきでも読む。読めなければ短く見せない", () => {
  const total = (prep, move) => {
    const plan = createPlan();
    applyUpdates(plan, [{ path: "evacuation.prepMinutes", value: prep }, { path: "evacuation.moveMinutes", value: move }], 1);
    return totalMinutes(plan);
  };
  assert.equal(total("１５", "３０"), 45);
  assert.equal(total("十五", "三十"), 45);
  assert.equal(total("15", "30分"), 45);
  assert.equal(total("15", "1時間"), 75);
  assert.equal(total("15", "1時間半"), 105);
  assert.equal(total("しばらく", "30"), null);
  const plan = createPlan();
  applyUpdates(plan, [{ path: "evacuation.prepMinutes", value: "しばらく" }, { path: "evacuation.moveMinutes", value: "30" }], 1);
  assert.equal(timeFinding(plan, 60).id, "in-time-unread");
});

test("点検：すり抜けた医療の判断と約束を残さない", () => {
  const f = (o) => ({ yardstick: "一本足", text: "知らせの手段が1つです。", interrupt: false, opener: null, request: null, ...o });
  for (const text of ["お薬は半分でも大丈夫です", "血圧は高めなので心配です", "薬を止めても平気です", "心臓に悪いので階段は避けて", "脳梗塞の再発に気をつけて", "入院をすすめます", "酸素は外してもよいです"]) {
    assert.deepEqual(acceptFindings([f({ text })], COMMON_YARDSTICKS), [], text);
  }
  for (const request of ["雨の夜は私が迎えに行く", "隣の人が毎晩迎えに来ます", "電話してあげます", "かならず連絡", "ぜったい来る", "責任をもって連れて行く"]) {
    assert.ok(!("request" in acceptFindings([f({ request })], COMMON_YARDSTICKS)[0]), request);
  }
});

test("深い入れ子の JSON でサーバーが落ちない", async (t) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../server.mjs", import.meta.url))], { env: { ...process.env, ANTHROPIC_API_KEY: "", APP_PASSWORD: "", HOST: "127.0.0.1", PORT: "0" } });
  t.after(() => child.kill());
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /localhost:(\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  const deep = `{"plan":{"care":${"[".repeat(5000)}${"]".repeat(5000)}}}`;
  const res = await fetch(`http://127.0.0.1:${port}/api/check`, { method: "POST", body: deep });
  assert.ok(res.status >= 400 && res.status < 500);
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
});

test("話した番号：言いよどみ、仮名、崩れた桁でも番号の部分だけ置き換える", () => {
  for (const [text, want] of [
    ["000のえっと1234の567 8", "[電話番号]"],
    ["16時に000 A 1234の56782", "16時に[電話番号]"],
    ["電話はゼロキューゼロ えっと イチニサンヨン ゴロクナナハチです", "電話は[電話番号]です"],
    ["〇九〇、あの、一二三四、五六七八", "[電話番号]"],
    ["電話は000えっと1234の5678に掛けて", "電話は[電話番号]に掛けて"],
  ]) {
    assert.equal(redact(text), want, text);
    assert.ok(personalKind(text), text);
  }
});

test("話した番号：ふつうの話や時間は変えない", () => {
  for (const text of ["あの公民館へ行く", "三丁目の一本松", "1番2番の順に回る", "デイサービス 月水金 09:00〜16:00 火 09:00〜12:00", "ゼロにしてください", "準備に10-15分", "0歳の孫と2人です", "さんにんで、ごはんを食べに行く"]) {
    assert.equal(redact(text), text, text);
  }
});

test("話した番号：区切りが多い形、一覧にない言いよどみ、長い挟み込み、後ろに続く数字", () => {
  for (const text of [
    "000の12の34の56の78",
    "000 12 34 56 78",
    "000ええと1234ええと5678",
    "ゼロキューゼロ ええと イチニーサンヨン ええと ゴーロクナナハチ",
    "000 あの えー 1234 あの えー 5678",
    "000うんと1234ちょっと5678",
    "000えーと1234えーと5678、1300",
  ]) {
    assert.ok(redact(text).includes("[電話番号]"), text);
    assert.ok(!/1234|イチニ/.test(redact(text)), text);
    assert.ok(personalKind(text), text);
  }
  assert.equal(redact("電話は000えっと1234の5678にしてください"), "電話は[電話番号]にしてください");
});

test("話した番号：ふつうの話を壊さず、長い文でも遅くならない", () => {
  for (const text of ["0900〜1200と1300〜1600", "05時に起きて06時に出る", "れいわごねんに", "0.5キロ歩く", "きれいにしてにしのまちへ行く"]) {
    assert.equal(redact(text), text, text);
  }
  const started = performance.now();
  redact("0" + "あ".repeat(1000));
  redact("0えー".repeat(300));
  assert.ok(performance.now() - started < 200);
});

test("名前：平仮名まじりの名前、水で終わる名字を伏せる。ふつうの言葉は残す", () => {
  for (const text of ["よし子さん", "ふみ子さん", "とし江さん", "まさ男さん", "清水くんです", "速水くんだ"]) {
    assert.ok(redact(text).includes("[お名前]"), text);
    assert.ok(!/よし|ふみ|とし|まさ|清水|速水/.test(redact(text)), text);
  }
  for (const text of ["お寺さんに逃げる", "その子さん", "お子さんが来る", "甥っ子さん", "水くんで"]) assert.equal(redact(text), text, text);
});

test("CSV の値の形：分けずにそのまま置き換え、記号は計画に入れない", () => {
  const known = [{ value: "あり 軽自動車", alias: "[手元の値]", kind: "whole" }];
  assert.equal(redact("あり 軽自動車です", known), "[手元の値]です");
  assert.equal(redact("ありがとう、軽自動車で", known), "ありがとう、軽自動車で");
  const memo = "[手元の値]で逃げます";
  assert.equal(acceptScribe({ updates: [{ path: "evacuation.means", value: "[手元の値]", quote: memo }], helpers: [] }, memo).length, 0);
});

test("名字＋職業、先生、平仮名の名前、空白入りの敬称を伏せる", () => {
  for (const text of ["山田会長さん", "佐藤看護師さん", "鈴木ヘルパーさん", "山田ケアマネさん", "山田保健師さん", "山田先生", "山田医師", "山田君", "山田殿", "山田 さん", "佐藤 様", "たなかさん", "さとうさん", "のぶこさん"]) {
    assert.ok(redact(text).includes("[お名前]"), text);
    assert.ok(!/山田|佐藤|鈴木|たなか|さとう|のぶこ/.test(redact(text)), text);
  }
});

test("職業と平仮名のふつうの言葉は残す", () => {
  for (const text of ["自治会長さん", "訪問看護師さん", "民生委員さん", "看護師さん", "ヘルパーさん", "校長先生", "主治医師", "おじいさん", "おばあちゃん", "たくさん", "みなさん", "ちゃんと飲む", "しっかりちゃんと飲む", "お巡りさん", "お地蔵さん", "公民館さん"]) {
    assert.equal(redact(text), text, text);
  }
});

test("頭の 0 が落ちた番号、記号入りの番号、区切りのない長い番号も伏せる", () => {
  for (const text of ["90-1234-5678", "9012345678", "8190-1234-5678", "000|1234|5678", "000（えー）1234（えー）5678", "オーキュウオー1234 5678", "1234567890"]) {
    assert.ok(redact(text).includes("[電話番号]"), text);
  }
  for (const text of ["2026年10月", "1000円です", "12345", "電話は3回"]) assert.equal(redact(text), text, text);
});

test("入口：欄の形でないものを断る", () => {
  const shaped = (patch) => ({ plan: { ...createPlan(), ...patch }, gaps: null });
  const care = createPlan().care;
  assert.notDeepEqual(validateCheckPayload(shaped({ care: { ...care, mobility: { value: ["000", "1234", "5678"], status: "filled", source: "human", memoId: null } } })), []);
  assert.notDeepEqual(validateCheckPayload(shaped({ care: { ...care, mobility: { foo: "自由な文" } } })), []);
  assert.notDeepEqual(validateCheckPayload(shaped({ extra: { x1: { foo: "自由な文" } } })), []);
  assert.deepEqual(validateCheckPayload(shaped({})), []);
});

test("問いかけの答えは、根拠にしない", () => {
  const take = (memo, quote) => acceptScribe({ updates: [{ path: "evacuation.place", value: "公民館", quote }], helpers: [] }, memo).map((x) => x.value);
  for (const memo of ["公民館でいい？", "公民館はどうかな", "公民館でいいですか", "公民館はいかがですか"]) assert.deepEqual(take(memo, "公民館"), [], memo);
  assert.deepEqual(take("公民館へ行きます", "公民館"), ["公民館"]);
});

test("2回に分けた番号、手元の名前の一部、生年月日、住所の言い方", () => {
  assert.ok(redact("電話は000。0000-1234です").includes("[電話番号]"));
  const name = [{ value: "佐藤花子", alias: "本人" }];
  assert.equal(redact("佐藤は二階で寝てます", name), "本人は二階で寝てます");
  assert.equal(redact("花子は耳が遠いです", name), "本人は耳が遠いです");
  for (const text of ["4月12日生まれです", "誕生日は4月12日です", "昭和14・4・12生まれ", "生まれは昭和14年4月です", "14年4月12日生まれ"]) assert.ok(redact(text).includes("[日付]"), text);
  const birth = [{ value: "1939-04-12", alias: "[日付]", kind: "birth" }];
  assert.equal(redact("昭和14年4月12日です", birth), "[日付]です");
  const address = [{ value: "字川上123-4 グリーンハイツ201", alias: "自宅", kind: "address" }];
  for (const text of ["川上の123の4です", "グリーンハイツの201号室です", "川上123に住んでます"]) assert.ok(!/123|グリーン/.test(redact(text, address)), text);
  for (const text of ["娘の家はミント町3-4です", "ミント市本町3番12号です", "グリーン荘の201号室です"]) assert.ok(redact(text).includes("[住所]"), text);
});

test("2字のかな名、手がかりのある名前を伏せる", () => {
  for (const text of ["きくさん", "みよさん", "はなさん", "うめちゃん", "たけさんよしこさんと", "田中といいます", "名前は田中です", "田中の奥さん", "田中宅", "田中ケアマネ", "山田看護師", "田中会長", "田中先輩"]) {
    assert.ok(redact(text).includes("[お名前]"), text);
    assert.ok(!/田中|山田|きく|みよ|はな|うめ|たけ|よしこ/.test(redact(text)), text);
  }
});

test("介護と避難のふつうの話は変えない", () => {
  for (const text of [
    "お宮さんへ逃げる", "八幡さんの広場", "お稲荷さん", "天神様", "氏神様", "弁天様", "お不動さん", "金比羅さん", "お大師様",
    "うちのばあちゃん", "うちのじいちゃん", "あのじいさん", "姑さん", "和尚さん", "神主さん", "村長さん", "館長さん", "お手伝いさん", "付き添いさん", "隣組さん", "当番さん", "見守り隊さん",
    "薬局さん", "福祉用具さん", "訪問入浴さん", "特養さん", "事業所さん", "訪問介護さん", "生協さん", "農協さん", "ガス屋さん", "水道屋さん", "弁当屋さん", "消防さん", "警察さん", "救急隊員さん", "病院さん", "通所さん", "老健さん",
    "空模様が悪いと", "ご先祖様", "お陰様", "お互い様", "お月様", "お日様", "ほとけさま", "おはようさん", "ご馳走様",
    "手すりちゃんと掴んで", "補聴器ちゃんと", "靴ちゃんと", "雨戸ちゃんと", "避難袋ちゃんと", "荷物ちゃんと", "玄関ちゃんと",
    "M6.4-6.5", "二丁目1つ先", "自宅にいます", "お宅へ伺います", "在宅です", "ねこちゃんも一緒", "おじさんが来る", "さとうの袋",
  ]) assert.equal(redact(text), text, text);
});

test("名字と同じ地名を、呼び名に変えない", () => {
  assert.equal(redact("家の前の小川があふれます", [{ value: "小川 花子", alias: "本人" }]), "家の前の小川があふれます");
  assert.equal(redact("大橋を渡って公民館へ", [{ value: "大橋 一郎", alias: "緊急連絡先" }]), "大橋を渡って公民館へ");
  assert.equal(redact("川上の公民館へ避難します", [{ value: "川上 修", alias: "隣の人" }]), "川上の公民館へ避難します");
  assert.equal(redact("小川 花子さんが来る", [{ value: "小川 花子", alias: "本人" }]).includes("小川"), false);
});

test("書き取り：根拠の文に無い体のことと人のことは入れない", () => {
  const memo = "薬は朝に飲みます。公民館へ行きます。隣の人に頼みました。";
  const take = (path, value, quote) => acceptScribe({ updates: [{ path, value, quote }], helpers: [] }, memo).map((x) => x.value);
  for (const value of ["薬は半分でよい", "降圧剤を増やす", "インスリンは打たない", "認知症の疑いがある"]) assert.deepEqual(take("considerations.items", value, "公民館"), [], value);
  assert.deepEqual(take("evacuation.means", "娘の車", "公民館"), []);
  assert.deepEqual(take("carry", "薬", "薬は朝に飲みます"), ["薬"]);
});

test("点検：医療の判断、言い切り、頼みごとの約束を残さない", () => {
  const y = [{ label: "物差し" }];
  for (const text of ["降圧剤の量が多いかもしれません", "脱水の恐れ", "誤嚥の危険", "お医者さんに相談してください", "かかりつけ医に相談", "痛み止めは続けてください", "もう安心です", "これで大丈夫です", "問題ありません", "避難できます"]) {
    assert.deepEqual(acceptFindings([{ yardstick: "物差し", text }], y), [], text);
  }
  for (const request of ["手伝います", "毎日見に行きます", "車を出します", "背負って逃げます", "お任せください", "引き受けます"]) {
    assert.equal(acceptFindings([{ yardstick: "物差し", text: "手伝う人はまだです", request }], y)[0].request, undefined, request);
  }
  assert.equal(acceptFindings([{ yardstick: "物差し", text: "x", request: "雨の日に電話を1本（娘さんへ）" }], y)[0].request, "雨の日に電話を1本（娘さんへ）");
});

test("手伝う人の同意がなくても避難先は隠さず、人の話は隠す", () => {
  const row = (place) => {
    const plan = createPlan();
    applyUpdates(plan, [{ path: "evacuation.place", value: place }], 1);
    plan.consent.evacuation = "yes";
    const config = { columns: ["先"], targets: { 先: "evacuation.place" }, alwaysColumns: [], neverColumns: [], consentGroups: { evacuation: { label: "x", columns: ["先"] } }, blankValue: "未決定" };
    return buildVillageRow({ plan, identity: {}, config, createdOn: "x" })[0];
  };
  for (const place of ["隣の集落の公民館", "隣の避難所", "近所の避難所", "隣接する公民館", "向かいの高台", "母子センター", "姉妹都市の施設", "おばけ坂の上の広場"]) assert.equal(row(place), place, place);
  for (const place of ["裏の人の車で", "職員が迎えに来る", "社協の車で", "姑の車で", "連れ合いと一緒に"]) assert.ok(row(place).includes("同意待ち"), place);
});

test("取り込みの見出し：ふつうの様式を止めない", () => {
  for (const h of ["利用者カナ氏名", "キーパーソン氏名", "かかりつけ医氏名", "親族氏名", "同居家族氏名", "続柄氏名", "通所先氏名", "施設長氏名", "主治医先生"]) {
    assert.deepEqual(maskTable({ headers: [h], rows: [["x"]] }).suspectHeaders, [], h);
  }
});

test("手元の番号：頭の 0 を落としても、一部だけ残らない", () => {
  const known = [{ value: "0999001111", alias: "[電話番号]", kind: "phone" }];
  assert.equal(redact("999-00-1111", known), "[電話番号]");
  assert.ok(!/1111/.test(redact("999-00-1111")));
});

test("ローマ字の名前を伏せ、短い英字の呼び方は残す", () => {
  assert.ok(redact("Tanakaさんが来る").includes("[お名前]"));
  assert.equal(redact("CMさんが来る"), "CMさんが来る");
});

test("避難先と住まいの言い方を、記号にしない", () => {
  for (const text of ["娘宅へ避難します", "息子宅", "親戚宅", "知人宅", "市営住宅の3階", "県営住宅", "仮設住宅", "日中自宅にいる", "夕方帰宅する", "終日在宅", "アパートの2階", "マンションの7階", "薬は持っていくんですね", "連れていくんです", "歩いていくんです", "行くんじゃなくて", "娘は小学校と言いますが", "ホームヘルパーさん", "巡回看護師さん", "訪問医師", "公民館長さん", "消防団長さん"]) {
    assert.equal(redact(text), text, text);
  }
  assert.ok(redact("田中宅へ避難します").includes("[お名前]"));
  assert.ok(redact("健太くんです").includes("[お名前]"));
});

test("手元の氏名は、空白がなくても名字と名前で探す", () => {
  const k = (value) => [{ value, alias: "本人" }];
  assert.equal(redact("娘の花子が迎えに来ます", k("長谷川花子")), "娘の本人が迎えに来ます");
  assert.equal(redact("長谷川の家に行きます", k("長谷川花子")), "本人の家に行きます");
  assert.equal(redact("娘の花子が来ます", k("森花子")), "娘の本人が来ます");
  assert.equal(redact("トメは一人で歩けます", k("山田トメ")), "本人は一人で歩けます");
  assert.equal(redact("佐々木の車で行きます", k("佐々木一郎")), "本人の車で行きます");
  assert.equal(redact("一郎に頼みました", k("佐々木一郎")), "本人に頼みました");
});

test("手元の住所と番号の、ほかの言い方", () => {
  const home = [{ value: "ハッカ村字ミナト 2-3-4 村営みなと住宅201", alias: "自宅", kind: "address" }];
  assert.ok(!redact("村営みなと住宅の201に住んでいます", home).includes("みなと"));
  assert.ok(!redact("2の3の4です", home).includes("2の3"));
  assert.ok(!redact("みなと2の3の4です", home).includes("みなと"));
  assert.ok(!redact("1203の5です", [{ value: "ハッカ村ミドリ1203-5", alias: "自宅", kind: "address" }]).includes("1203"));
  assert.ok(!redact("みなと町の5-6です", [{ value: "みなと町三丁目5番6号", alias: "自宅", kind: "address" }]).includes("5-6"));
  assert.ok(!redact("1234の5678です", [{ value: "00012345678", alias: "[電話番号]", kind: "phone" }]).includes("5678"));
});

test("名字と同じ地名を呼び名にせず、呼び名で始まる避難先は入れない", () => {
  assert.equal(redact("川上の高台に逃げます", [{ value: "川上 ハナ", alias: "本人" }]), "川上の高台に逃げます");
  assert.equal(redact("松原の寺に逃げます", [{ value: "松原 タケ", alias: "本人" }]), "松原の寺に逃げます");
  assert.equal(redact("大山の広場に集まります", [{ value: "大山 一郎", alias: "緊急連絡先" }]), "大山の広場に集まります");
  const memo = "本人の高台に逃げます";
  assert.deepEqual(acceptScribe({ updates: [{ path: "evacuation.place", value: "本人の高台", quote: memo }], helpers: [] }, memo), []);
});

test("頼みごとの案：頼む形は残し、約束と連絡の指図は落とす", () => {
  const y = [{ label: "物差し" }];
  const kept = (request) => acceptFindings([{ yardstick: "物差し", text: "x", request }], y)[0].request;
  for (const r of ["石段を降りるときだけ、手を貸してください", "大雨の日の朝に、声をかけてください", "雨の夜に電話を1本お願いします", "避難のときに声をかけてもらえると助かります", "玄関まで一緒に出てくださいね"]) assert.equal(kept(r), r);
  for (const r of ["隣の人が車で送る", "車に乗せてあげる", "連れて行ってあげる", "避難所まで連れて行く", "夜は隣の人が見に行く", "主治医に電話を1本", "病院へ連れて行く", "[お名前]に電話を1本", "[手元の値]に電話を1本"]) assert.equal(kept(r), undefined, r);
});

test("書き取り：本人の事実と、足していく配慮を落とさず、聞いていない値は入れない", () => {
  const take = (path, value, quote, plan = {}) => acceptScribe({ updates: [{ path, value, quote }], helpers: [] }, quote, [], plan).map((x) => x.value);
  for (const v of ["酸素を外すと息が苦しい", "インスリンを打たないといけない", "朝の薬を飲まないと動けない", "薬は半分に割って飲む"]) assert.deepEqual(take("considerations.items", v, v), [v], v);
  assert.deepEqual(take("carry", "お薬手帳", "おくすり手帳を持ちます"), ["お薬手帳"]);
  const plan = { considerations: { items: { value: "薬の管理は娘" } } };
  assert.deepEqual(take("considerations.items", "薬の管理は娘、右耳が遠い", "右耳も遠い", plan), ["薬の管理は娘、右耳が遠い"]);
  assert.deepEqual(take("carry", "酸素ボンベと補聴器", "補聴器を袋に入れています"), []);
  assert.deepEqual(take("evacuation.means", "車いす", "公民館まで10分です"), []);
  assert.deepEqual(take("contactMeans", "防災無線と電話", "電話で聞きます"), []);
  assert.deepEqual(take("considerations.items", "薬は減らしてよい", "薬は多い"), []);
});

test("書き取り：頼めたは、その人を含む節だけで見る", () => {
  const memo = "娘に頼みました、隣の人には来週話します";
  const out = acceptScribe({ updates: [], helpers: [{ alias: "隣の人", awayWeekdayDaytime: false, asked: true, quote: "隣の人には来週話します" }] }, memo);
  assert.equal(out[0].value.asked, false);
});

test("点検：聞けていないという指摘は残し、体の判断は落とす", () => {
  const y = [{ label: "物差し" }];
  const has = (text) => acceptFindings([{ yardstick: "物差し", text }], y).length;
  for (const text of ["インスリンの保冷バッグを持って出る段取りを、まだ聞けていません", "透析の日の昼に、そばにいる人をまだ聞けていません", "降圧剤を持って出る段取りを聞けていません", "認知症で夜に歩くことがあるので、夜の手伝う人をまだ聞けていません"]) assert.equal(has(text), 1, text);
  for (const text of ["足が悪いので車いすに変えたほうがよいです", "夜は水分を多めにとるとよいです", "歩くのは控えたほうがよさそうです"]) assert.equal(has(text), 0, text);
});

test("同意なしで、人の話を CSV に出さない（追加の言葉）", () => {
  const row = (place) => {
    const plan = createPlan();
    applyUpdates(plan, [{ path: "evacuation.place", value: place }], 1);
    plan.consent.evacuation = "yes";
    const config = { columns: ["先"], targets: { 先: "evacuation.place" }, alwaysColumns: [], neverColumns: [], consentGroups: { evacuation: { label: "x", columns: ["先"] } }, blankValue: "未決定" };
    return buildVillageRow({ plan, identity: {}, config, createdOn: "x" })[0];
  };
  for (const p of ["佐藤宅", "幼なじみの家", "教え子の家", "同級生の車で", "老人クラブの仲間の車で"]) assert.ok(row(p).includes("同意待ち"), p);
  assert.equal(row("自宅の2階"), "自宅の2階");
});

test("暮らしの言葉（追加）を変えない", () => {
  for (const text of ["歩ける様にしておきます", "校区会長さんに話してあります", "老人クラブ会長が声をかけます", "社会福祉士さんが来ます", "保健婦さんが来ました", "新聞配達さんが朝来ます", "豆腐屋さんが週1で来ます", "灯油屋さんが来ます", "クリーニング屋さんです", "店長さんが見に来ます", "議員さんに相談しました", "サポーターさんが来ます", "配食さんが昼に来ます", "自治会さんの名簿です", "町内会さんにお願いします", "送迎さんが朝来ます", "知り合いさんに聞きます", "いとこさんが近くにいます", "隣のおっちゃんに頼みました", "隣のばっちゃんが心配です", "親類さんがいます", "自治会の奥さんが見に来ます", "二階のおばあちゃんが心配です", "団地のおじいさんも一緒です", "老人会のおばあちゃんが誘います", "農家の奥さんが野菜を持ってきます"]) {
    assert.equal(redact(text), text, text);
  }
  assert.ok(redact("山田様に頼みます").includes("[お名前]"));
  assert.ok(redact("田中の奥さんが来ます").includes("[お名前]"));
});

test("局番を言わない番号、言葉の直後の番号", () => {
  const known = [{ value: "0995550142", alias: "[電話番号]", kind: "phone" }];
  for (const text of ["電話は555の0142です", "うちの番号は555-0142やで", "電話は5550142"]) assert.ok(!redact(text, known).includes("0142"), text);
  for (const text of ["隣の家の電話は555の7788よ", "電話番号は555-7788です", "連絡先は45の1234です"]) assert.ok(redact(text).includes("[電話番号]"), text);
  assert.ok(redact("郵便番号は899-0000です").includes("[郵便番号]"));
  for (const text of ["電話は3回かけます", "電話は朝7時です", "携帯は持っていません"]) assert.equal(redact(text), text, text);
});

test("生年月日の「の生まれ」、片仮名の名、住所の「の」", () => {
  for (const text of ["昭和11年の生まれです", "昭和十一年の生まれで", "昭和11年4月の生まれ", "四月三日が誕生日で"]) assert.ok(redact(text).includes("[日付]"), text);
  const birth = [{ value: "1936-04-03", alias: "[日付]", kind: "birth" }];
  assert.equal(redact("昭和十一年四月三日です", birth), "[日付]です");
  assert.equal(redact("ハルは今年で九十です", [{ value: "岡野 ハル", alias: "本人" }]), "本人は今年で九十です");
  for (const text of ["港町2丁目の4の7です", "北町の5の12です", "うちは三丁目の5の12やね"]) assert.ok(redact(text).includes("[住所]"), text);
  const home = [{ value: "字ミナト2-3-4 村営みなと住宅201", alias: "自宅", kind: "address" }];
  for (const text of ["村営みなと住宅201です", "みなと住宅の201です"]) assert.ok(!redact(text, home).includes("みなと"), text);
  assert.equal(redact("三丁目の公民館へ"), "三丁目の公民館へ");
});

test("手がかりのある名前（追加）", () => {
  for (const text of ["佐藤のばあちゃん", "田中のじいちゃん", "佐藤の爺さん", "高橋の婆さん", "木村の息子", "松本の兄ちゃん", "佐藤班長", "田中組長", "佐藤トメと申します", "名前はサトウトメです"]) {
    assert.ok(redact(text).includes("[お名前]"), text);
  }
  for (const text of ["自分の息子", "隣の息子", "班長さん", "組長さん", "うちの息子"]) assert.equal(redact(text), text, text);
});

test("点検：指摘の残すものと落とすもの（追加）", () => {
  const y = [{ label: "物差し" }];
  const has = (text) => acceptFindings([{ yardstick: "物差し", text }], y).length;
  for (const text of ["透析を休むと命に関わります", "薬が切れると危険です", "低血糖に注意してください", "発作が起きやすいので気をつけてください", "転倒のおそれがあるので、無理に歩かないほうがいいです", "症状が悪くなるかもしれません", "これで安心です", "もう大丈夫です", "小学校まで間に合うと思います", "ご家族に伝えておきます", "娘さんに電話してください"]) assert.equal(has(text), 0, text);
  for (const text of ["雨の夜に誰が連絡してくれるか、まだ聞けていません。", "毎晩ひとりになると聞いていますが、夜に手伝う人はまだ聞けていません。", "病院へ行く日の昼に、そばにいる人をまだ聞けていません。", "体育館までの道を一緒に確かめておくとよいです。", "認知症のご主人が夜どこにいるかを、次に聞いておきたいです。"]) assert.equal(has(text), 1, text);
  const kept = (request) => acceptFindings([{ yardstick: "物差し", text: "x", request }], y)[0].request;
  for (const r of ["雨の夜は付き添う", "車を出す", "荷物を持つ", "一緒に逃げる", "雨の夜に声をかける", "石段で手を引く", "雨の夜に様子を見る"]) assert.equal(kept(r), undefined, r);
  assert.equal(kept("電話を1本お願いいたします"), "電話を1本お願いいたします");
});

test("手伝う人：呼び名を保ち、同意なしで人の話を出さない（追加）", () => {
  const helper = (memo, alias) => acceptScribe({ updates: [], helpers: [{ alias, awayWeekdayDaytime: false, asked: true, quote: memo }] }, memo)[0]?.value.alias;
  assert.equal(helper("長男に頼んであります", "長男"), "長男");
  assert.equal(helper("区長さんに頼みました", "区長さん"), "区長さん");
  assert.equal(helper("となりの人に頼んであります", "隣の人"), "隣の人");
  assert.equal(helper("主人に頼みました", "ご主人"), "ご主人");
  const row = (place, people = []) => {
    const plan = createPlan();
    applyUpdates(plan, [{ path: "evacuation.place", value: place }], 1);
    plan.consent.evacuation = "yes";
    const config = { columns: ["先"], targets: { 先: "evacuation.place" }, alwaysColumns: [], neverColumns: [], consentGroups: { evacuation: { label: "x", columns: ["先"] } }, blankValue: "未決定" };
    return buildVillageRow({ plan, identity: {}, people, config, createdOn: "x" })[0];
  };
  for (const p of ["裏のおっちゃんの軽トラ", "となりが乗せてくれる", "かあちゃんが連れて行ってくれる", "にいちゃんの車", "せがれの車", "だんなの車", "若い衆が担いでくれる"]) assert.ok(row(p).includes("同意待ち"), p);
  assert.ok(row("佐々木の車", [{ alias: "隣の人", name: "佐々木花子" }]).includes("同意待ち"));
  assert.equal(row("となりの地区の公民館"), "となりの地区の公民館");
});

test("点検：事実の話を落とさず、問いかけだけがだめなら案は残す", () => {
  const y = [{ label: "物差し" }];
  const has = (text) => acceptFindings([{ yardstick: "物差し", text }], y).length;
  for (const text of ["決まった手伝う人は、まだいません。", "知らせが必ず届くとは限らないので、もう1つあると安心です。", "電話してくれる方がまだいません。", "夜は毎晩おひとりのようです。", "裏の崖が崩れるおそれがあるので、大雨の夜に寝る部屋を確かめたいです。"]) assert.equal(has(text), 1, text);
  for (const text of ["もう決まった。", "必ず来てくれます", "お医者さんに相談してください"]) assert.equal(has(text), 0, text);
  const [one] = acceptFindings([{ yardstick: "物差し", text: "夜の手伝いはまだです", interrupt: true, opener: "診断はありますか", request: "雨の夜に、電話を1本" }], y);
  assert.equal(one.interrupt, undefined);
  assert.equal(one.request, "雨の夜に、電話を1本");
});

test("書き取り：答えの言い方を落とさない", () => {
  const take = (path, value, memo) => acceptScribe({ updates: [{ path, value, quote: memo }], helpers: [] }, memo).map((x) => x.value);
  assert.deepEqual(take("evacuation.place", "公民館", "公民館でいいです"), ["公民館"]);
  assert.deepEqual(take("evacuation.place", "小学校", "逃げる先は小学校でいい"), ["小学校"]);
  assert.deepEqual(take("evacuation.place", "公民館", "公民館でいいですか"), []);
  assert.deepEqual(take("considerations.items", "朝の薬はもう飲まなくなった", "朝の薬はもう飲まなくなったそうです"), ["朝の薬はもう飲まなくなった"]);
  assert.deepEqual(take("considerations.items", "薬はやめたほうがいい", "薬はやめたほうがいい"), []);
});

test("役職の語を残し、名字が付けば伏せる。詰めた氏名＋さんも丸ごと置き換える", () => {
  for (const text of ["自治会の役員さんに頼む", "防災士さん", "世話人さん", "理事さん", "代表さん", "社長さん", "業者さん"]) assert.equal(redact(text), text, text);
  assert.ok(redact("山田社長さん").includes("[お名前]"));
  assert.equal(redact("岡野ハルさんが来る", [{ value: "岡野 ハル", alias: "本人" }]), "本人が来る");
});

test("書き取り：聞いていない約束と医療の判断を入れない。同じ文にある言葉は通す", () => {
  const take = (path, value, memo, quote = memo) => acceptScribe({ updates: [{ path, value, quote }], helpers: [] }, memo).map((x) => x.value);
  assert.deepEqual(take("evacuation.means", "娘が必ず迎えに来る", "娘に聞いてみます"), []);
  assert.deepEqual(take("evacuation.means", "隣の人が迎えに来てくれる", "隣の人が来てくれるかもしれません"), []);
  assert.deepEqual(take("care.mobility", "受診が必要", "足が痛いです"), []);
  assert.deepEqual(take("considerations.items", "民生委員が担当に決まった", "民生委員に話してみようかな"), []);
  assert.deepEqual(take("carry", "薬は台所の棚の上", "薬は台所の棚の上に置いてあります", "台所の棚の上"), ["薬は台所の棚の上"]);
});

test("点検：中止や不要の判断、言い切りを残さない", () => {
  const y = [{ label: "物差し" }];
  const has = (text) => acceptFindings([{ yardstick: "物差し", text }], y).length;
  for (const text of ["インスリンを中止しましょう", "薬を中止しましょう", "歩行器はもう不要です", "点滴は不要です", "血圧の薬はもう要りません", "リハビリで歩けるようになります", "隣の人が雨の夜に電話をしてくれます", "民生委員が担当することになりました"]) assert.equal(has(text), 0, text);
  assert.equal(has("車はまだ決めていません。"), 1);
  const kept = (request) => acceptFindings([{ yardstick: "物差し", text: "x", request }], y)[0].request;
  for (const r of ["息子さんが車で避難させることに決まりました", "隣の人が担当することになりました", "隣の人が引き受けました", "隣の人が手を貸してくれることになりました"]) assert.equal(kept(r), undefined, r);
  assert.equal(kept("雨の夜に電話をかけてください"), "雨の夜に電話をかけてください");
});

test("手元の番号：局番ごと置き換える", () => {
  const known = [{ value: "0007550142", alias: "[電話番号]", kind: "phone" }];
  assert.equal(redact("0007-55-0142です", known), "[電話番号]です");
  assert.equal(redact("0007の55の0142です", known), "[電話番号]です");
});

test("地名や順番の「の息子」を伏せず、続き柄の呼び名を保つ", () => {
  for (const text of ["一番上の息子は東京にいる", "東京の息子に電話する", "二番目の息子", "市内の息子", "隣村の息子", "島外の息子", "大学生の息子"]) assert.equal(redact(text), text, text);
  assert.ok(redact("木村の息子").includes("[お名前]"));
  const memo = "奥さんが介助している";
  for (const alias of ["奥さん", "家内", "ケアマネ", "いとこ", "おばあちゃん"]) {
    const m = `${alias}が介助している`;
    assert.equal(acceptScribe({ updates: [], helpers: [{ alias, awayWeekdayDaytime: false, asked: false, quote: m }] }, m)[0].value.alias, alias, alias);
  }
  assert.ok(memo);
});

test("「◯◯の奥さん」「◯◯の息子」：ふつうの言葉は残し、よくある名字は伏せる", () => {
  for (const text of ["認知症の奥さんを介護している", "同居の息子は夜だけいる", "別居の息子", "遠方の娘", "県内の息子", "本土の息子", "千葉の息子", "車椅子の奥さん", "入院中の奥さん", "難聴の奥さん", "透析の奥さん", "二人の息子", "独身の息子", "三軒先のおばあちゃん", "裏手のおじいさん", "友達の奥さん", "花屋の奥さん", "同級生の奥さん"]) {
    assert.equal(redact(text), text, text);
  }
  for (const text of ["田中の奥さんが来ます", "木村の息子", "佐藤のばあちゃん", "松本の兄ちゃん"]) assert.ok(redact(text).includes("[お名前]"), text);
  assert.equal(redact("岡野直樹の奥さん", [{ value: "岡野直樹", alias: "緊急連絡先" }]), "緊急連絡先の奥さん");
  assert.equal(redact("緊急連絡先の奥さん"), "緊急連絡先の奥さん");
});

test("となりの人を捨てず、メールアドレスを伏せる", () => {
  const out = acceptScribe({ updates: [], helpers: [{ alias: "となりの人", awayWeekdayDaytime: false, asked: false, quote: "となりの人とあいさつ" }] }, "となりの人とあいさつをする");
  assert.equal(out[0].value.alias, "となりの人");
  const mail = "hatsu.okano" + "@" + "example.jp";
  assert.equal(redact(`メールは${mail}です`), "メールは[メール]です");
  assert.equal(personalKind(mail), "メール");
});
