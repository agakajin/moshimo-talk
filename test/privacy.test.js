// 読み取り専用のレビュー役が見つけた破れ方を、二度と起こさないために残す。値はすべて架空
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { maskTable } from "../src/core/mask.js";
import { applyUpdates, createPlan, importRow } from "../src/core/plan.js";
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

test("CSV の文の列も住所を伏せ、どの列も伏せ字を通す", () => {
  const headers = ["氏名", "住所", "危険", "介護度"];
  const row = ["山田 花子", "ハッカ村字川5-3", "字川5番地3の裏は崖", "山田 花子"];
  const { plan } = importRow({ headers, row, mapping: { 氏名: "self.name", 住所: "self.address", 危険: "home.hazardNote", 介護度: "care.level" } });
  assert.ok(!/字川|5番地/.test(plan.home.hazardNote.value));
  assert.ok(!/山田/.test(plan.care.level.value));
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
  assert.deepEqual(take("carry", "常備薬と懐中電灯と着替えと通帳", "通帳も持つ"), ["常備薬と懐中電灯と着替えと通帳"]);
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
