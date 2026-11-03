// 様式を差し替えても、聞く欄、点検、書き出しが様式に合わせて動くか
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeCsv, parseCsv } from "../src/core/csv.js";
import { attachOutput, blankColumns, buildInputRow, checkResumedFormat, DEFAULT_TARGETS, duplicateHeaders, hasInputConsent, inputConsentGroups, planFieldList, requiredBlanks, suspiciousHeaders } from "../src/core/format.js";
import { buildVillageRow, hasCityConsent, toCsvText } from "../src/core/output.js";
import { applyUpdates, createPlan, editField, fieldsBefore, fromResumeFile, importRow, placedFields, planForClaude, setIdentity, toResumeFile } from "../src/core/plan.js";
import { acceptScribe, acceptColumns, summarizePlan } from "../src/server/claude.js";
import { mockReadColumns } from "../src/server/mock-reader.js";
import { OUTPUT_READER_TARGETS, scribePrompt, SCRIBE } from "../src/server/prompts.js";
import { validateCheckPayload, validateColumnsPayload, validateScribePayload } from "../src/server/validate.js";
import { maskTable } from "../src/core/mask.js";
import { redact } from "../src/core/redact.js";

const read = (name) => readFileSync(new URL(`../samples/${name}`, import.meta.url));
const VILLAGE = JSON.parse(read("hakka-village.config.json"));
const MAPPING = JSON.parse(read("keahakka.mapping.json"));

function okano() {
  const { headers, rows } = parseCsv(decodeCsv(read("keahakka_okano.csv")));
  return importRow({ headers, row: rows[0], mapping: MAPPING });
}

const hakka = (imported) => attachOutput(imported, { base: VILLAGE, columns: VILLAGE.columns.map((header) => ({ header, target: DEFAULT_TARGETS[header] })) });

function mint(imported) {
  const { headers } = parseCsv(decodeCsv(read("mint-city.format.csv")));
  const results = mockReadColumns({ kind: "output", columns: headers.map((header) => ({ header })) });
  return attachOutput(imported, { base: VILLAGE, name: "ミント市", columns: results });
}

const cell = (config, row, name) => row[config.columns.indexOf(name)];
const allYes = (plan) => { for (const k of Object.keys(plan.consent)) plan.consent[k] = "yes"; };

test("3つ目の様式：見出しを読み、無い欄は聞く欄として足す", () => {
  const imported = okano();
  const config = mint(imported);
  assert.deepEqual(imported.customs.map((c) => c.label), ["住居の種類", "居住階"]);
  assert.equal(config.targets["町内会名"], "home.community");
  const labels = planFieldList(imported).map((f) => f.label);
  assert.ok(labels.includes("住居の種類"));
  assert.ok(labels.includes("避難先"), "出口の見出しを欄の名前にする");
});

test("3つ目の様式：話した内容が様式の列に入る", () => {
  const imported = okano();
  const config = mint(imported);
  const { plan } = imported;
  const floor = imported.customs.find((c) => c.label === "居住階").path;
  applyUpdates(plan, [
    { path: "evacuation.place", value: "小学校" },
    { path: floor, value: "2階" },
    { path: "evacuation.prepMinutes", value: "15" },
    { path: "evacuation.moveMinutes", value: "30" },
  ], 1);
  allYes(plan);
  const row = buildVillageRow({ ...imported, config, createdOn: "2026-11-03" });
  assert.equal(cell(config, row, "避難先"), "小学校");
  assert.equal(cell(config, row, "居住階"), "2階");
  assert.equal(cell(config, row, "所要時間"), "45");
  assert.equal(cell(config, row, "作成日"), "2026-11-03");
  assert.equal(row.length, config.columns.length);
  assert.ok(toCsvText(config.columns, row).startsWith("﻿整理番号,"));
});

test("様式の欄も、同意がなければ出さない", () => {
  const imported = okano();
  const config = mint(imported);
  const floor = imported.customs.find((c) => c.label === "居住階").path;
  applyUpdates(imported.plan, [{ path: floor, value: "2階" }], 1);
  imported.plan.consent.evacuation = "yes";
  assert.equal(cell(config, buildVillageRow({ ...imported, config, createdOn: "x" }), "居住階"), "");
  imported.plan.consent.other = "yes";
  assert.equal(cell(config, buildVillageRow({ ...imported, config, createdOn: "x" }), "居住階"), "2階");
});

test("欄に印が付く。両方にある欄は1つで、避難計画に入る欄が先に並ぶ", () => {
  const imported = okano();
  hakka(imported);
  const fields = planFieldList(imported);
  const of = (label) => fields.find((f) => f.label === label);
  assert.equal(of("寝室").mark, "両方", "両方にある欄はケアプランの列名で出す");
  assert.equal(of("避難場所").mark, "避難計画書のみ");
  assert.equal(fields.filter((f) => f.path === "home.bedroom").length, 1);
  assert.equal(of("知らせの受け方").mark, "様式の外");
  assert.equal(of("持ち出し").mark, "本人の1枚");
  const rank = (mark) => fields.findIndex((f) => f.mark === mark);
  assert.ok(rank("避難計画書のみ") < rank("様式の外"));
});

test("両方の様式にある新しい欄は、まとめて1つにする", () => {
  const { headers, rows } = parseCsv("氏名,居住階\n架空 花子,1階\n");
  const imported = importRow({ headers, row: rows[0], mapping: { 氏名: "self.name", 居住階: "new" } });
  attachOutput(imported, { columns: [{ header: "居住階", target: "new" }] });
  assert.equal(imported.customs.length, 1);
  const [field] = planFieldList(imported).filter((f) => f.label === "居住階");
  assert.equal(field.mark, "両方");
  assert.equal(imported.plan.extra.x1.value, "1階");
});

test("話した階段と聞こえ方、家のまわりの危険が市向けの列に届く", () => {
  const imported = okano();
  const config = hakka(imported);
  allYes(imported.plan);
  editField(imported.plan, "care.stairs", "手すりで一人で降りられる");
  const row = buildVillageRow({ ...imported, config, createdOn: "x" });
  assert.match(cell(config, row, "避難時の配慮事項"), /手すりで一人で降りられる/);
  assert.match(cell(config, row, "避難時の配慮事項"), /補聴器/);
  assert.match(cell(config, row, "自宅の災害リスク"), /石段/);
});

test("点検に渡す空きは、様式の列から作る", () => {
  const imported = okano();
  const config = mint(imported);
  const blanks = blankColumns(config, imported.plan);
  for (const name of ["避難先", "住居の種類", "同行者"]) assert.ok(blanks.includes(name), name);
  for (const name of ["氏名", "作成日", "配慮事項"]) assert.ok(!blanks.includes(name), name);
  applyUpdates(imported.plan, [{ path: "evacuation.place", value: "小学校" }], 1);
  assert.ok(!blankColumns(config, imported.plan).includes("避難先"));
});

test("入口の様式へ書き出す：同じ見出しで、元の値を残し、同意した分だけ変える", () => {
  const imported = okano();
  const { plan, input } = imported;
  editField(plan, "care.stairs", "手すりで一人で降りられる");
  const before = buildInputRow({ input, plan });
  assert.deepEqual(before.row, input.row, "同意がなければ元のまま");
  assert.equal(before.changes[0].allowed, false);
  plan.consentInput.care = "yes";
  const after = buildInputRow({ input, plan });
  assert.equal(after.row[input.headers.indexOf("階段")], "手すりで一人で降りられる");
  assert.equal(after.row[input.headers.indexOf("利用者名")], input.row[input.headers.indexOf("利用者名")]);
  assert.equal(after.row.length, input.headers.length);
  plan.consent.care = "no";
  assert.equal(buildInputRow({ input, plan }).row[input.headers.indexOf("階段")], "手すりで一人で降りられる", "市への同意とは別");
});

test("手で入れたときは、入口へ書き出す様式がない", () => {
  assert.equal(importRow({ headers: ["self.name"], row: ["架空 花子"], mapping: { "self.name": "self.name" }, source: "human" }).input, null);
});

test("続き用ファイルで、様式と足した欄が戻る", () => {
  const imported = okano();
  const config = mint(imported);
  const floor = imported.customs.find((c) => c.label === "居住階");
  applyUpdates(imported.plan, [{ path: floor.path, value: "2階" }], 1);
  const again = fromResumeFile(JSON.parse(JSON.stringify(toResumeFile(imported))));
  assert.equal(again.plan.extra[floor.key].value, "2階");
  assert.deepEqual(again.output.columns, config.columns);
  assert.deepEqual(again.input.headers, imported.input.headers);
  assert.deepEqual(again.customs, imported.customs);
});

test("書き取り：足した欄に書ける。一覧にない欄には書けない", () => {
  const fields = [{ key: "extra.x1", label: "居住階" }];
  const memo = "2階にお住まいなんですね";
  assert.equal(acceptScribe({ updates: [{ path: "extra.x1", value: "2階", quote: "2階" }], helpers: [] }, memo, fields).length, 1);
  assert.equal(acceptScribe({ updates: [{ path: "extra.x2", value: "2階", quote: "2階" }], helpers: [] }, memo, fields).length, 0);
  assert.equal(scribePrompt([]), SCRIBE);
  assert.ok(scribePrompt(fields).schema.properties.updates.items.properties.path.enum.includes("extra.x1"));
  assert.doesNotMatch(scribePrompt(fields).system, /居住階/, "見出しは指示の文に入れない");
  assert.match(scribePrompt(fields).system, /fields/);
});

test("Claude へ足した欄の値は届き、同意と見出しは届かない", () => {
  const plan = createPlan();
  plan.extra.x1 = { status: "filled", value: "2階", source: "voice", memoId: 1 };
  const sent = summarizePlan(plan);
  assert.equal(sent.extra.x1, "2階");
  assert.equal(sent.consent, undefined);
  assert.equal(sent.consentInput, undefined);
});

test("入口：足した欄の形と、様式の見出しを調べる", () => {
  const plan = createPlan();
  plan.extra.x1 = { status: "filled", value: "2階", source: "voice", memoId: 1 };
  const fields = [{ key: "extra.x1", label: "居住階" }];
  assert.deepEqual(validateCheckPayload({ plan, gaps: null, blanks: ["避難先"], fields }), []);
  assert.deepEqual(validateScribePayload({ memo: "2階", plan, fields }), []);
  assert.notDeepEqual(validateCheckPayload({ plan, gaps: null, fields: [{ key: "care.level", label: "x" }] }), []);
  assert.notDeepEqual(validateCheckPayload({ plan, gaps: null, fields: [{ key: "extra.x1", label: "000-0000-0000" }] }), []);
  assert.notDeepEqual(validateCheckPayload({ plan, gaps: null, blanks: ["山田 花子"] }), []);
  const named = createPlan();
  named.extra["山田"] = { status: "filled", value: "x", source: "human", memoId: null };
  assert.notDeepEqual(validateCheckPayload({ plan: named, gaps: null }), []);
  plan.extra.x1.value = "000-1234-5678";
  assert.notDeepEqual(validateCheckPayload({ plan, gaps: null }), []);
  assert.deepEqual(validateColumnsPayload({ kind: "output", columns: [{ header: "避難先", withheld: false, samples: [] }] }), []);
  assert.notDeepEqual(validateColumnsPayload({ kind: "other", columns: [{ header: "避難先", withheld: false, samples: [] }] }), []);
  assert.notDeepEqual(validateColumnsPayload({ kind: "output", columns: [{ header: "山田 花子", withheld: false, samples: [] }] }), []);
});

test("様式の読み解き：一覧にない内容は分からないのまま人に聞く", () => {
  const out = acceptColumns([{ header: "A", target: "evacuation.place", confidence: "high" }, { header: "B", target: "何か", confidence: "high" }], [{ header: "A" }, { header: "B" }, { header: "C" }], OUTPUT_READER_TARGETS);
  assert.deepEqual(out.map((r) => r.target), ["evacuation.place", "unknown", "unknown"]);
});

test("必須の空き：様式の列から作り、入れば消える", () => {
  const imported = okano();
  mint(imported);
  const first = requiredBlanks(imported);
  for (const path of ["evacuation.place", "evacuation.means", "evacuation.prepMinutes", "evacuation.moveMinutes", "home.community"]) assert.ok(first.fields.has(path), path);
  assert.ok(!first.fields.has("care.mobility"), "CSV で入っている");
  assert.ok(!first.fields.has("considerations.items"), "配慮事項は歩き方で足りる");
  assert.ok(!first.fields.has("carry"), "様式に無い");
  assert.equal(first.helper, "同行者");
  assert.deepEqual(first.local, [], "手元の情報は揃っている");
  applyUpdates(imported.plan, [{ path: "evacuation.place", value: "小学校" }, { path: "helpers.add", value: { alias: "隣の人", asked: true } }], 1);
  const next = requiredBlanks(imported);
  assert.ok(!next.fields.has("evacuation.place"));
  assert.equal(next.helper, null);
});

test("必須の空き：1列にまとまる欄が全部空なら1つだけ、手元の情報は分ける", () => {
  const imported = importRow({ headers: ["氏名"], row: ["架空 花子"], mapping: { 氏名: "self.name" } });
  attachOutput(imported, { columns: [{ header: "氏名", target: "self.name" }, { header: "電話", target: "self.phone" }, { header: "配慮", target: "considerations.all" }, { header: "空", target: "none" }] });
  const { fields, local } = requiredBlanks(imported);
  assert.deepEqual([...fields.keys()], ["care.mobility"]);
  assert.deepEqual(local, ["電話"]);
});

test("様式を変えても話した内容は残り、前の様式だけの空の欄は消える", () => {
  const imported = okano();
  mint(imported);
  const floor = imported.customs.find((c) => c.label === "居住階");
  applyUpdates(imported.plan, [{ path: floor.path, value: "2階" }, { path: "evacuation.place", value: "小学校" }], 1);
  const config = hakka(imported);
  const fields = planFieldList(imported);
  const labels = fields.map((f) => f.label);
  assert.ok(labels.includes("居住階"), "話した内容がある欄は残す");
  assert.ok(!labels.includes("住居の種類"), "空の欄は消える");
  assert.equal(fields.find((f) => f.label === "居住階").mark, "様式の外");
  allYes(imported.plan);
  const row = buildVillageRow({ ...imported, config, createdOn: "x" });
  assert.equal(cell(config, row, "避難場所"), "小学校");
  assert.equal(row.length, VILLAGE.columns.length);
});

test("同じ見出しが2つある様式は受け付けない：手伝う人の名前が同意なしで出るため", () => {
  assert.deepEqual(duplicateHeaders(["氏名", "電話", "氏名", "電話", "住所"]), ["氏名", "電話"]);
  const imported = okano();
  assert.throws(() => attachOutput(imported, { columns: [{ header: "氏名", target: "self.name" }, { header: "氏名", target: "helper1.name" }] }), /同じ見出し/);
});

test("様式が変わると同意を聞き直す。同じ様式のまま進むなら残す", () => {
  const imported = okano();
  hakka(imported);
  allYes(imported.plan);
  hakka(imported);
  assert.equal(imported.plan.consent.contact, "yes", "同じ様式");
  assert.ok(!imported.consentReset);
  const config = mint(imported);
  assert.ok(Object.values(imported.plan.consent).every((v) => v === "unasked"));
  assert.equal(imported.consentReset, true);
  assert.equal(cell(config, buildVillageRow({ ...imported, config, createdOn: "x" }), "電話"), "");
});

test("今の様式に無い分類の同意では、書き出せない", () => {
  const plan = createPlan();
  plan.consent.contact = "yes";
  assert.equal(hasCityConsent(plan, { consentGroups: { care: {} } }), false);
  assert.equal(hasCityConsent(plan, { consentGroups: { contact: {} } }), true);
});

test("ケアプラン用：入口の見出しに行き先がある分類だけ聞き、同意が無ければ保存しない", () => {
  const imported = okano();
  const groups = inputConsentGroups(imported);
  assert.ok(groups.includes("care"));
  assert.ok(!groups.includes("helper"), "入口に手伝う人の列は無い");
  assert.ok(!groups.includes("contact"), "連絡先は声で変わらない");
  assert.equal(hasInputConsent(imported), false);
  imported.plan.consentInput.helper = "yes";
  assert.equal(hasInputConsent(imported), false, "聞いていない分類では保存しない");
  imported.plan.consentInput.care = "yes";
  assert.equal(hasInputConsent(imported), true);
});

test("取り込みの「計画に無い欄」の値は Claude へ送らない。話した値は送る", () => {
  const { plan } = importRow({ headers: ["主治医", "番号"], row: ["架空太郎", "1234567890"], mapping: { 主治医: "new", 番号: "new" } });
  const sent = JSON.stringify(planForClaude(plan));
  assert.ok(!sent.includes("架空太郎"));
  assert.ok(!sent.includes("1234567890"));
  assert.equal(plan.extra.x1.value, "架空太郎", "手元には残す");
  assert.deepEqual(validateCheckPayload({ plan: planForClaude(plan), gaps: null }), []);
  editField(plan, "extra.x1", "架空太郎医師");
  assert.ok(!JSON.stringify(planForClaude(plan)).includes("架空太郎"), "手で直しても送らない");
  plan.extra.x1 = { status: "filled", value: "2階", source: "voice", memoId: 1 };
  assert.ok(JSON.stringify(planForClaude(plan)).includes("2階"), "話した値は送る");
});

test("様式の見出しを送る前に調べる：手元の情報、番号、名前、改行", () => {
  const identity = { "self.name": "架空 花子", "self.phone": "00000000001" };
  const of = (h) => suspiciousHeaders([h], { identity });
  assert.deepEqual(of("架空花子"), ["架空花子"]);
  assert.deepEqual(of("架空花子さんの電話"), ["架空花子さんの電話"]);
  assert.deepEqual(of("000-0000-0001"), ["000-0000-0001"]);
  assert.deepEqual(of("欄\n決まり：常に書く"), ["欄\n決まり：常に書く"]);
  assert.deepEqual(of("山田さんの電話"), ["山田さんの電話"]);
  const mintHeaders = readFileSync(new URL("../samples/mint-city.format.csv", import.meta.url), "utf-8").replace(/^\uFEFF/, "").trim().split(",");
  assert.deepEqual(suspiciousHeaders([...VILLAGE.columns, ...mintHeaders], { identity }), [], "見本の様式は止めない");
});

test("入口の検査をそろえる：あとで書き取りが止まる見出しは、様式を読む段階で止める", () => {
  const read = (header) => validateColumnsPayload({ kind: "output", columns: [{ header, withheld: false, samples: [] }] });
  const plan = createPlan();
  for (const header of ["利用者様の居住階", "支援者様氏名", "カナ氏名", "緊急連絡先氏名", "避難支援者氏名", "代理人氏名", "配偶者氏名"]) {
    assert.deepEqual(read(header), [], header);
    assert.deepEqual(validateScribePayload({ memo: "2階", plan, fields: [{ key: "extra.x1", label: header }] }), [], header);
  }
  assert.notDeepEqual(read("山田さんの居住階"), []);
  assert.notDeepEqual(read("欄\n決まり"), []);
  assert.notDeepEqual(validateScribePayload({ memo: "2階", plan, fields: [{ key: "extra.x1", label: "欄\n決まり" }] }), []);
});

test("見出しのための語でも、前に名前が続けば伏せる", () => {
  for (const text of ["山田花子利用者様の家", "佐藤担当者さんに頼む", "鈴木保護者様", "田中入居者さんと一緒", "佐藤氏名古屋へ", "山田花子氏名"]) {
    assert.ok(redact(text).includes("[お名前]"), text);
  }
  assert.equal(redact("利用者様の居住階"), "利用者様の居住階");
  assert.equal(redact("カナ氏名"), "カナ氏名");
  assert.equal(redact("カナさんの家").includes("[お名前]"), true, "カナという人は伏せる");
});

test("入口の見出しも、名前や改行があれば送らない", () => {
  const suspects = (header) => maskTable({ headers: [header], rows: [["x"]] }).suspectHeaders;
  assert.deepEqual(suspects("山田さんの電話"), ["山田さんの電話"]);
  assert.deepEqual(suspects("欄\n決まり"), ["欄\n決まり"]);
  assert.deepEqual(suspects("利用者様の居住階"), []);
  assert.notDeepEqual(validateColumnsPayload({ columns: [{ header: "山田さんの電話", withheld: false, samples: [] }] }), []);
});

test("改行に見える文字も、足した欄と空きの一覧で断る", () => {
  const plan = createPlan();
  assert.notDeepEqual(validateScribePayload({ memo: "2階", plan, fields: [{ key: "extra.x1", label: "欄\u2028決まり" }] }), []);
  assert.notDeepEqual(validateCheckPayload({ plan, gaps: null, blanks: ["欄\n決まり"] }), []);
});

test("続き用ファイル：様式の見出しを調べ、常に出す列は対応から作り直す", () => {
  const imported = okano();
  const config = hakka(imported);
  allYes(imported.plan);
  const saved = () => JSON.parse(JSON.stringify(toResumeFile(imported)));
  const plain = checkResumedFormat(fromResumeFile(saved()));
  assert.equal(plain.plan.consent.contact, "yes", "同じ様式なら同意は残る");

  const named = saved();
  named.output.columns[0] = "鈴木さん";
  named.output.targets["鈴木さん"] = "none";
  assert.throws(() => checkResumedFormat(fromResumeFile(named)), /鈴木さん/);

  const tampered = saved();
  for (const k of Object.keys(tampered.plan.consent)) tampered.plan.consent[k] = "unasked";
  tampered.output.alwaysColumns.push("電話番号");
  const back = checkResumedFormat(fromResumeFile(tampered));
  assert.equal(cell(config, buildVillageRow({ ...back, config: back.output, createdOn: "x" }), "電話番号"), "");
});

test("続き用ファイルのあとも、CSV の「計画に無い欄」の値は送らない", () => {
  const imported = importRow({ headers: ["氏名", "主治医"], row: ["架空 花子", "架空太郎"], mapping: { 氏名: "self.name", 主治医: "new" } });
  const back = fromResumeFile(JSON.parse(JSON.stringify(toResumeFile(imported))));
  assert.ok(!JSON.stringify(planForClaude(back.plan)).includes("架空太郎"));
});

test("別の様式を通って戻っても、前の同意は残らない", () => {
  const imported = okano();
  hakka(imported);
  allYes(imported.plan);
  mint(imported);
  hakka(imported);
  assert.ok(Object.values(imported.plan.consent).every((v) => v === "unasked"));
  assert.equal(imported.consentReset, true);
});

test("持ち出しと過ごし方は、暮らしの同意で出す", () => {
  const imported = okano();
  const config = attachOutput(imported, { base: VILLAGE, columns: [{ header: "持ち出し", target: "carry" }, { header: "過ごし方", target: "timeBands" }] });
  applyUpdates(imported.plan, [{ path: "carry", value: "心臓の薬" }, { path: "timeBands", value: "月水金はデイ" }], 1);
  imported.plan.consent.evacuation = "yes";
  assert.deepEqual(buildVillageRow({ ...imported, config, createdOn: "x" }), ["", ""]);
  imported.plan.consent.care = "yes";
  assert.deepEqual(buildVillageRow({ ...imported, config, createdOn: "x" }), ["心臓の薬", "月水金はデイ"]);
});

test("準備と移動を別の列にでき、頼めた人の名前が無ければ手元の空きに出る", () => {
  const imported = okano();
  const config = attachOutput(imported, { base: VILLAGE, columns: [{ header: "準備", target: "evacuation.prepMinutes" }, { header: "移動", target: "evacuation.moveMinutes" }, { header: "同行者", target: "helper1.name" }] });
  applyUpdates(imported.plan, [{ path: "evacuation.prepMinutes", value: "10" }, { path: "evacuation.moveMinutes", value: "20" }], 1);
  imported.plan.consent.evacuation = "yes";
  assert.deepEqual(buildVillageRow({ ...imported, config, createdOn: "x" }).slice(0, 2), ["10", "20"]);
  imported.plan.helpers.push({ alias: "隣の人", asked: true });
  assert.deepEqual(requiredBlanks({ ...imported, people: [] }).local.filter((h) => h === "同行者"), ["同行者"]);
  assert.deepEqual(requiredBlanks({ ...imported, people: [{ alias: "隣の人", name: "架空 隣" }] }).local.filter((h) => h === "同行者"), []);
});

test("プログラムの部品と同じ見出しは止める。行末のカンマの空の見出しは数えない", () => {
  for (const h of ["__proto__", "constructor", "toString"]) {
    assert.deepEqual(suspiciousHeaders([h]), [h]);
    assert.deepEqual(maskTable({ headers: [h], rows: [["x"]] }).suspectHeaders, [h]);
  }
  assert.deepEqual(parseCsv("氏名,電話,\nあ,い,\n").headers, ["氏名", "電話"]);
});

test("ケアプラン用：欄を空にしても元の値を残し、そのことを返す", () => {
  const imported = okano();
  editField(imported.plan, "care.stairs", "");
  const { row, kept } = buildInputRow(imported);
  assert.ok(kept.includes("階段"));
  assert.equal(row[imported.input.headers.indexOf("階段")], imported.input.row[imported.input.headers.indexOf("階段")]);
});

test("読めない時間は空きとして見せる", () => {
  const imported = okano();
  mint(imported);
  editField(imported.plan, "evacuation.prepMinutes", "10");
  editField(imported.plan, "evacuation.moveMinutes", "30分から1時間");
  assert.ok(requiredBlanks(imported).fields.has("evacuation.moveMinutes"));
});

test("続き用ファイル：形の違うものを断り、入らなかった声メモを残す", () => {
  const imported = okano();
  hakka(imported);
  const data = JSON.parse(JSON.stringify(toResumeFile({ ...imported, looseMemos: ["あとで入れる話"] })));
  assert.deepEqual(fromResumeFile(data).looseMemos, ["あとで入れる話"]);
  const week = JSON.parse(JSON.stringify(data));
  week.plan.care.weekly.value = "月水金";
  assert.throws(() => checkResumedFormat(fromResumeFile(week)), /形が正しくありません/);
  const cols = JSON.parse(JSON.stringify(data));
  cols.output.columns = "氏名";
  assert.throws(() => checkResumedFormat(fromResumeFile(cols)), /形が正しくありません/);
});

test("閉じていない引用符を知らせる", () => {
  assert.equal(parseCsv('氏名,住所\n架空,"村1\n次郎,村2\n').unclosed, true);
  assert.equal(parseCsv('氏名,住所\n架空,"村1"\n').unclosed, undefined);
});

test("閉じ忘れの引用符が2行で対になった値を知らせる", () => {
  assert.equal(parseCsv('氏名,備考\nA,"娘\nB,"息子\n').unclosed, true);
  assert.equal(parseCsv('氏名,備考\nA,"1行目\n2行目"\n').unclosed, undefined);
});

test("手元の情報：読めない値では元の値を消さない", () => {
  const identity = { "self.birth": "1939-04-12" };
  assert.equal(setIdentity(identity, "self.birth", "よくわからない"), null);
  assert.equal(identity["self.birth"], "1939-04-12");
  assert.equal(setIdentity(identity, "self.birth", ""), "");
});

test("同じ値の書き取りは、入ったと数えない", () => {
  const plan = createPlan();
  applyUpdates(plan, [{ path: "evacuation.place", value: "公民館" }], 1);
  const before = fieldsBefore(plan, [{ path: "evacuation.place", value: "公民館" }, { path: "evacuation.means", value: "車" }]);
  applyUpdates(plan, [{ path: "evacuation.place", value: "公民館" }, { path: "evacuation.means", value: "車" }], 2);
  assert.deepEqual([...placedFields(plan, before, 2).keys()], ["evacuation.means"]);
});

test("頼めた人が2人でも、名前を入れた人が列に入る。名前のない2人目は空きに出る", () => {
  const imported = okano();
  const columns = [{ header: "同行者", target: "helper1.name" }, { header: "同行者電話", target: "helper1.phone" }, { header: "同行者2", target: "helper2.name" }];
  const config = attachOutput(imported, { base: VILLAGE, columns });
  imported.plan.helpers.push({ alias: "隣の親子", asked: true }, { alias: "娘さん", asked: true });
  imported.people = [{ alias: "娘さん", name: "架空 花", phone: "00000000002" }];
  imported.plan.consent.helper = "yes";
  const row = buildVillageRow({ ...imported, config, createdOn: "x" });
  assert.equal(row[0], "架空 花");
  assert.ok(row[1].replace(/\D/g, "").endsWith("0002"));
  assert.deepEqual(requiredBlanks(imported).local.filter((h) => h.startsWith("同行者")), ["同行者2"]);
});
