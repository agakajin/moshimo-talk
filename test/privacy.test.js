// 読み取り専用のレビュー役が見つけた破れ方を、二度と起こさないために残す。値はすべて架空
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { maskTable } from "../src/core/mask.js";
import { applyUpdates, createPlan, importRow } from "../src/core/plan.js";
import { buildVillageRow, toCsvText } from "../src/core/output.js";
import { personalKind, redact, redactDeep } from "../src/core/redact.js";
import { validateCheckPayload, validateColumnsPayload, validateScribePayload } from "../src/server/validate.js";
import { acceptFindings, acceptScribe } from "../src/server/claude.js";
import { COMMON_YARDSTICKS } from "../src/server/prompts.js";

const KNOWN = [
  { value: "山田 花子", alias: "本人" },
  { value: "やまだ はなこ", alias: "本人" },
  { value: "ハッカ村字山田12-3", alias: "自宅", kind: "address" },
];

test("生年月日の形は、手元に無くても置き換える", () => {
  for (const memo of ["昭和10年5月3日生まれ", "1935年5月3日", "S10.5.3"]) {
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

test("区切りが違う電話番号も、一部だけの番号も置き換える", () => {
  for (const memo of ["０００－１２３４－５６７８", "000ー1234ー5678", "000−1234−5678", "000.1234.5678", "000の1234の5678", "〇〇〇ー一二三四ー五六七八", "52-1234"]) {
    assert.match(redact(memo), /\[電話番号\]/, memo);
    assert.equal(personalKind(memo), "電話番号", memo);
  }
});

test("名字と地名が重なっても、住所を壊さず置き換える。一部だけ話しても置き換える", () => {
  assert.equal(redact("ハッカ村字山田12-3", KNOWN), "自宅");
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
