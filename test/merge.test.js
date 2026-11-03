import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { decodeCsv, parseCsv } from "../src/core/csv.js";
import { attachOutput, buildInputRow, DEFAULT_TARGETS } from "../src/core/format.js";
import { chooseConflict, describeFlows, findPersonRow, mergeOutputRow } from "../src/core/merge.js";
import { fromResumeFile, importRow, toResumeFile } from "../src/core/plan.js";

const person = () => importRow({
  headers: ["名前", "生年月日", "介護度", "歩き方"],
  row: ["岡野 ハル", "1939/4/12", "要介護1", "杖歩行"],
  mapping: { 名前: "self.name", 生年月日: "self.birth", 介護度: "care.level", 歩き方: "care.mobility" },
});
const merge = (imported, cells) => {
  const headers = Object.keys(cells);
  const targets = Object.fromEntries(headers.map((h) => [h, DEFAULT_TARGETS[h]]));
  return mergeOutputRow(imported, { headers, row: Object.values(cells), targets, blankValue: "未決定" });
};

test("本人の行は、名前と生年月日で1行に決まるときだけ選ぶ", () => {
  const targets = { 氏名: "self.name", 生年月日: "self.birth" };
  const headers = ["氏名", "生年月日"];
  const identity = person().identity;
  assert.equal(findPersonRow({ headers, rows: [["𠮷川 正一", "1944/1/7"], ["岡野　ハル", "1939/4/12"]] }, targets, identity), 1);
  assert.equal(findPersonRow({ headers, rows: [["岡野 ハル", "1950/1/1"]] }, targets, identity), null, "同姓同名の別の人");
  assert.equal(findPersonRow({ headers, rows: [["岡野 ハル", ""], ["岡野ハル", ""]] }, targets, identity), null, "2行あるなら決めない");
  assert.equal(findPersonRow({ headers, rows: [["別の人", "1939/4/12"]] }, targets, identity), null);
});

test("空の欄だけ埋め、違う値は黙って変えずに返す", () => {
  const imported = person();
  const result = merge(imported, { 自治会名: "ミドリ区自治会", 要介護度: "要支援2", 緊急連絡先1氏名: "平井 ユキ" });
  assert.equal(imported.plan.home.community.value, "ミドリ区自治会");
  assert.equal(imported.plan.home.community.source, "csv");
  assert.equal(imported.identity["emergency.name"], "平井 ユキ");
  assert.equal(imported.plan.care.level.value, "要介護1");
  assert.deepEqual(result.conflicts.map((c) => [c.key, c.current, c.incoming]), [["care.level", "要介護1", "要支援2"]]);
});

test("書き出したときの空の印は値として読まない", () => {
  const imported = person();
  const result = merge(imported, { 自治会名: "未決定", 避難場所: "（手伝う人の同意待ち）" });
  assert.equal(imported.plan.home.community.status, "undecided");
  assert.equal(imported.plan.evacuation.place.status, "undecided");
  assert.equal(result.filled.length, 0);
});

test("手伝う人は名前を手元に入れるが、頼めたの印は付けない", () => {
  const imported = person();
  merge(imported, { 避難支援者1氏名: "平井 ユキ", 避難支援者1続柄: "娘", 避難支援者1電話: "000-0000-0009" });
  assert.deepEqual(imported.people, [{ name: "平井 ユキ", alias: "娘", phone: "00000000009" }]);
  assert.equal(imported.plan.helpers[0].alias, "娘");
  assert.equal(imported.plan.helpers[0].asked, false);
});

test("続柄に名前らしいものがあれば、Claude へ送る呼び名に使わない", () => {
  const imported = person();
  merge(imported, { 避難支援者1氏名: "平井 ユキ", 避難支援者1続柄: "000-0000-0009" });
  assert.equal(imported.people[0].alias, "手伝う人1");
});

test("1列にまとめて書かれた文は、下の欄が埋まっていれば手元に残す", () => {
  const imported = person();
  merge(imported, { 避難時の配慮事項: "杖歩行。夜は平井さんが付き添う", 避難方法: "車いすで30分" });
  assert.equal(imported.plan.considerations.items.status, "undecided");
  assert.deepEqual(imported.leftovers.map((l) => l.label), ["避難時の配慮事項", "避難方法"]);
});

test("計画書を選んだ値はケアプランへ同意があれば戻り、ケアプランの値を選べば戻らない", () => {
  const imported = person();
  const { conflicts } = merge(imported, { 要介護度: "要支援2" });
  chooseConflict(imported, conflicts[0], true);
  assert.equal(imported.plan.care.level.value, "要支援2");
  imported.plan.consentInput.care = "yes";
  const row = (state) => buildInputRow({ input: state.input, plan: state.plan, fromOutput: state.fromOutput }).row;
  assert.equal(row(imported)[2], "要支援2");
  imported.plan.consentInput.care = "unasked";
  assert.equal(row(imported)[2], "要介護1");
  chooseConflict(imported, conflicts[0], false);
  imported.plan.consentInput.care = "yes";
  assert.equal(row(imported)[2], "要介護1");
});

test("計画書から入った印は、続き用ファイルでも残る", () => {
  const imported = person();
  merge(imported, { 管理番号: "H-0012", 自治会名: "ミドリ区自治会", 避難方法: "車いすで30分" });
  const back = fromResumeFile(JSON.parse(JSON.stringify(toResumeFile(imported))));
  assert.deepEqual(back.fromOutput, ["home.community"]);
  assert.equal(back.serial, "H-0012");
  assert.equal(back.leftovers[0].label, "避難方法");
});

test("渡す列ごとに値の元を示し、表記だけの違いは違う値としない", () => {
  const imported = person();
  const columns = [
    { header: "氏名", target: "self.name" }, { header: "生年月日", target: "self.birth" }, { header: "要介護度", target: "care.level" },
    { header: "配慮", target: "considerations.all" }, { header: "自治会名", target: "home.community" }, { header: "避難場所", target: "evacuation.place" },
    { header: "電話", target: "self.phone" }, { header: "携帯", target: "none" }, { header: "作成日", target: "meta.createdOn" }, { header: "備考欄", target: "unknown" },
  ];
  const planHeaders = ["生年月日", "要介護度", "自治会名"];
  const { rows, unused } = describeFlows({ columns, input: imported.input, plan: imported.plan, planHeaders, planRow: ["昭和14年4月12日", "要支援2", "ミドリ区自治会"] });
  const by = Object.fromEntries(rows.map((r) => [r.header, r]));
  assert.equal(by.氏名.kind, "care");
  assert.equal(by.生年月日.differs ?? null, null);
  assert.equal(by.要介護度.differs, "要支援2");
  assert.deepEqual(by.配慮.from.map((c) => c.header), ["歩き方"]);
  assert.equal(by.自治会名.kind, "plan");
  assert.equal(by.避難場所.kind, "talk");
  assert.equal(by.電話.kind, "hand");
  assert.equal(by.携帯.kind, "none");
  assert.equal(by.作成日.kind, "auto");
  assert.equal(by.備考欄.kind, "unknown");
  assert.deepEqual(unused, []);
  const few = describeFlows({ columns: [{ header: "氏名", target: "self.name" }], input: imported.input, plan: imported.plan });
  assert.deepEqual(few.unused, ["生年月日", "介護度", "歩き方"]);
});

test("訪問で聞いた値は、もとの CSV の値より先に見せる", () => {
  const imported = person();
  Object.assign(imported.plan.care.mobility, { value: "車いす", source: "voice" });
  const { rows } = describeFlows({ columns: [{ header: "歩行", target: "care.mobility" }], input: imported.input, plan: imported.plan });
  assert.equal(rows[0].kind, "talk");
  assert.deepEqual(rows[0].talked, ["車いす"]);
});

test("見本の計画書は岡野さんと𠮷川さんの行に当たり、見出しはハッカ村と同じ", async () => {
  const table = parseCsv(decodeCsv(await readFile(new URL("../samples/hakka-keikaku.csv", import.meta.url))));
  const village = JSON.parse(await readFile(new URL("../samples/hakka-village.config.json", import.meta.url), "utf-8"));
  assert.deepEqual(table.headers, village.columns);
  const imported = person();
  attachOutput(imported, { base: village, columns: village.columns.map((header) => ({ header, target: DEFAULT_TARGETS[header] })) });
  assert.equal(findPersonRow(table, imported.output.targets, imported.identity), 0);
  assert.equal(findPersonRow(table, imported.output.targets, { "self.name": "𠮷川 正一", "self.birth": "1944-01-07" }), 1);
});
