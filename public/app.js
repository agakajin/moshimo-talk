// 取り込みの画面。本物の値はこの画面の中だけで扱い、サーバーへは記号だけを送る
import { decodeCsv, parseCsv } from "/core/csv.js";
import { maskTable } from "/core/mask.js";
import { findLeaks } from "/core/redact.js";
import { attachOutput, checkResumedFormat, DEFAULT_TARGETS, duplicateHeaders, expand, isOwnNumberColumn, OUTPUT_TARGETS, suspiciousHeaders } from "/core/format.js";
import { chooseConflict, describeFlows, findPersonRow, mergeOutputRow, pendingRechecks } from "/core/merge.js";
import { fromResumeFile, importRow, serviceGaps } from "/core/plan.js";
import { startTalk } from "/talk.js";

const TARGETS = {
  "self.name": "本人の氏名",
  "self.kana": "本人のふりがな",
  "self.birth": "生年月日",
  "self.gender": "性別",
  "self.postal": "郵便番号",
  "self.address": "住所",
  "self.phone": "本人の電話",
  "care.level": "要介護度",
  "care.weekly": "週間のサービス予定",
  "care.mobility": "歩き方",
  "care.stairs": "階段の昇り降り",
  "care.hearing": "聞こえ方",
  "care.household": "同居の有無",
  "home.usualRoom": "普段いる部屋",
  "home.bedroom": "寝室",
  "home.hazardNote": "家の中と周辺の危険個所",
  "emergency.name": "緊急連絡先の氏名",
  "emergency.phone": "緊急連絡先の電話",
  notes: "備考（Claude に送らない）",
  new: "計画に無い欄（話の中で聞く）",
  ignore: "使わない",
  unknown: "分からない（選んでください）",
};
// 話すことと、それで埋まる欄。もう片方のデータで分かっている話は聞かない
const TALK_TOPICS = [
  ["もしものときに心配なこと", ["hazards.items"]],
  ["逃げる先", ["evacuation.place"]],
  ["誰と、何で、何分で行くか", ["evacuation.means", "evacuation.moveMinutes"]],
  ["ご近所で顔を知っている人", []],
  ["避難の知らせの受け方", ["contactMeans"]],
  ["持ち出すもの", ["carry"]],
];
const WEEK = ["月", "火", "水", "木", "金", "土", "日"];

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};
const showError = (node, message) => { node.textContent = message; node.hidden = !message; };

const state = { table: null, masked: null, results: null, slots: { care: null, plan: null } };

const MANUAL_FIELDS = [
  ["self.name", "氏名"], ["self.kana", "ふりがな"], ["self.birth", "生年月日"], ["self.gender", "性別"],
  ["self.address", "住所"], ["self.phone", "本人の電話"], ["emergency.name", "緊急連絡先の氏名"], ["emergency.phone", "緊急連絡先の電話"],
  ["care.level", "要介護度"], ["care.weekly", "週のサービス（例：デイサービス 月水金 9:00-16:00）"],
  ["care.mobility", "歩き方、移動の方法"], ["care.stairs", "階段の昇り降り"], ["care.hearing", "聞こえ方、見え方"],
  ["home.usualRoom", "普段いる部屋"], ["home.bedroom", "寝室"], ["care.household", "同居の有無"], ["home.hazardNote", "家の中と周辺の危険個所"],
];

async function loadVillage() {
  state.village ??= await fetch("/samples/hakka-village.config.json").then((r) => r.json());
  return state.village;
}

const defaultColumns = (village) => village.columns.map((header) => ({ header, target: DEFAULT_TARGETS[header] ?? "unknown" }));

async function beginTalk(imported, options = {}) {
  // 二度押しで訪問の画面を二重に動かさない。待っている列の読み取りの答えも捨てる
  if (state.talkStarted) return;
  state.talkStarted = true;
  columnsRequest += 1;
  state.imported = imported;
  try {
    // 様式を選ばずに始めたときは、ハッカ村の様式にする
    if (!imported.output) {
      const village = await loadVillage();
      attachOutput(imported, { base: village, columns: defaultColumns(village) });
    }
  } catch {
    state.talkStarted = false;
    showError($("fileError"), "画面の設定を読めませんでした。もう一度押してください。");
    return;
  }
  for (const id of ["step1", "step2", "step4", "step5", "manual"]) $(id).hidden = true;
  document.querySelector(".steps").hidden = true;
  document.body.classList.remove("home");
  document.body.classList.add("wide-mode");
  document.querySelector(".top h1").textContent = "訪問";
  document.querySelector(".top p").textContent = "話を聞いて、段取りと次の一歩を決めます。決めるのはご本人です。";
  startTalk(imported, options);
}

function goTo(step) {
  // 終わった段階は積み重ねず、今の段階だけを見せる
  for (const i of [1, 2, 4, 5]) {
    $(`step${i}`).hidden = i !== step;
    const mark = document.querySelector(`.steps [data-step="${i}"]`);
    mark.classList.toggle("current", i === step);
    mark.classList.toggle("done", i < step);
  }
  if (step !== 1) $("manual").hidden = true;
  document.body.classList.toggle("home", step === 1);
  window.scrollTo(0, 0);
}

// CSV を読み、問題があれば理由を返す。見出しだけの様式は needRows なしで通す
function readTable(bytes, { needRows }) {
  const table = parseCsv(decodeCsv(bytes));
  if (table.unclosed) return { error: "引用符（\"）が閉じていない値があります。次の行まで1つの値に入ってしまうので、CSV を確かめてください。" };
  if (table.headers.length === 0 || (needRows && table.rows.length === 0)) return { error: needRows ? "見出しとデータのある CSV を選んでください。" : "見出しのある CSV を選んでください。" };
  const repeated = duplicateHeaders(table.headers);
  if (repeated.length > 0) return { error: `同じ見出しが2つあります：${repeated.join("、")}。見出しを分けてから選んでください。` };
  // 値のカンマで列がずれると、本物の値が別の欄に入る。取り込まずに知らせる
  const shifted = table.rows.findIndex((r) => r.slice(table.headers.length).some((v) => v.trim() !== ""));
  if (shifted >= 0) return { error: `${shifted + 2}行目の列の数が、見出しより多くなっています。値の中のカンマを確かめてください。` };
  return { table };
}

function putSlot(key, name, bytes) {
  showError($("fileError"), "");
  const { table, error } = readTable(bytes, { needRows: key === "care" });
  if (error) {
    showError($("fileError"), `${name}：${error}`);
    return;
  }
  state.slots[key] = { name, table };
  renderSlots();
}

function renderSlots() {
  const { care, plan } = state.slots;
  for (const [key, id] of [["care", "slotCare"], ["plan", "slotPlan"]]) {
    const box = $(id);
    const data = state.slots[key];
    box.classList.toggle("filled", Boolean(data));
    box.querySelector(".slot-empty").hidden = Boolean(data);
    box.querySelector(".slot-filled").hidden = !data;
    if (!data) continue;
    const { headers, rows } = data.table;
    box.querySelector(".slot-name").textContent = data.name;
    box.querySelector(".slot-info").textContent = rows.length > 0 ? `${rows.length}件、${headers.length}列` : `見出しだけ、${headers.length}列（値は入っていません）`;
  }
  $("connect").disabled = !care && !plan;
  $("swapSlots").disabled = !care && !plan;
  $("connectNote").textContent = care && plan ? "2つをつないで、話すことを絞ります。"
    : care ? "計画書は入れなくても進めます。あとで様式を選びます。"
    : plan ? "計画書の内容から始めます。"
    : "";
}

async function takeFiles(key, files) {
  await configReady;
  const other = key === "care" ? "plan" : "care";
  const list = [...files].slice(0, 2);
  const wrong = list.find((f) => !/\.csv$/i.test(f.name));
  if (wrong) {
    showError($("fileError"), `${wrong.name} は CSV ではありません。CSV を入れてください。`);
    return;
  }
  // 2つ一緒に入れたら、もう片方にも入れる。逆なら ⇄ で入れ替えられる
  const targets = list.length === 2 ? [key, other] : [key];
  for (const [i, target] of targets.entries()) putSlot(target, list[i].name, new Uint8Array(await list[i].arrayBuffer()));
}

function connect() {
  showError($("fileError"), "");
  const { care, plan } = state.slots;
  state.table = null;
  state.masked = null;
  state.mapping = null;
  state.results = null;
  state.careEdits = {};
  state.links = {};
  state.rowIndex = 0;
  state.whoChosen = undefined;
  state.flowTab = null;
  if (care) {
    loadCare(care.table);
    return;
  }
  if (plan) {
    state.imported = freshImported();
    prepareFormat();
    goTo(4);
  }
}

function loadCare(table) {
  // 訪問を始めたあとに遅れて届いた読み込みで、別の人の画面を開かない
  if (state.talkStarted) return;
  // 待っている答えは、前のファイルのもの
  columnsRequest += 1;
  $("send").disabled = false;
  $("sendState").hidden = true;
  state.table = table;
  state.masked = maskTable(table);
  renderMask();
  goTo(2);
}

// 入口の値だけが入った計画を作り直す。もう片方の値を入れ直しても前の値が残らないように
function freshImported() {
  if (!state.table || !state.mapping) return importRow({ headers: [], row: [], mapping: {}, source: "human" });
  const imported = importRow({ headers: state.table.headers, row: state.table.rows[state.rowIndex], mapping: state.mapping });
  // 計画に無い欄でつないだ列は、計画書の列と同じ欄にする
  for (const custom of imported.customs) custom.label = state.links?.[custom.label] ?? custom.label;
  return imported;
}

// 計画書のファイルがあれば、その見出しで様式を読む。無ければ今の様式のまま。confirmed は見出しを送る画面で見せたあと
function prepareFormat({ confirmed = false } = {}) {
  const plan = state.slots.plan;
  if (plan && state.formatTaken !== plan) {
    state.formatTaken = plan;
    takeFormat(plan.name, plan.table, { confirmed });
    return;
  }
  if (!plan) {
    state.formatTaken = null;
    state.formatData = null;
  }
  chooseFormat(state.formatName ?? "ハッカ村", state.formatHeaders ?? null);
}

// 様式の見出しと値を受け取る。見出しは Claude へ送る前に見せ、値は手元に残す
async function takeFormat(fileName, { headers, rows }, { confirmed = false } = {}) {
  formatRequest += 1;
  state.whoChosen = undefined;
  $("formatDefault").disabled = false;
  $("formatMint").disabled = false;
  $("formatState").hidden = true;
  $("formatSend").hidden = true;
  $("formatGo").disabled = true;
  $("formatWhoRow").hidden = true;
  clearFlows();
  showError($("formatError"), "");
  const name = fileName.replace(/\.csv$/i, "");
  // ハッカ村と同じ見出しなら、Claude に読ませない
  const village = await loadVillage();
  if (headers.length === village.columns.length && headers.every((h, i) => h === village.columns[i])) {
    state.formatData = { name: "ハッカ村", headers, rows };
    chooseFormat("ハッカ村", null);
    return;
  }
  const suspicious = suspiciousHeaders(headers, state.imported ?? {});
  if (suspicious.length > 0) {
    state.formatData = null;
    showError($("formatError"), `見出しに改行や、名前、番号らしいものがあるので、送らずに止めました：${suspicious.join("、")}`);
    return;
  }
  state.formatData = { name, headers, rows };
  if (confirmed) {
    chooseFormat(name, headers);
    return;
  }
  // 取り込みと同じく、送る前に中身を見せる
  $("formatSendList").textContent = headers.join("、");
  $("formatSendGo").onclick = () => chooseFormat(name, headers);
  $("formatSend").hidden = false;
}

function renderMask() {
  const { payload, suspectHeaders } = state.masked;
  // 「同居」列の値「同居」のように、見出しの言葉と同じ値は本物の値と見ない
  const values = state.table.rows.flat().filter((v) => !payload.columns.some((c) => c.header.includes(v.trim())));
  const leaks = findLeaks(payload, values);
  const blocked = suspectHeaders.length > 0 || leaks.length > 0;
  $("suspect").hidden = !blocked;
  $("suspect").textContent = blocked
    ? `見出しに、本物の値らしいものがあります。送らずに止めました。CSV の見出しを確かめてください。${suspectHeaders.length ? `（${suspectHeaders.join("、")}）` : ""}`
    : "";
  $("send").disabled = blocked;

  const table = $("maskTable");
  // 元の値はこの画面の中だけで見せる。送る中身には入れない
  const { rows } = state.table;
  table.replaceChildren(el("tr", {},
    el("th", { textContent: "列の見出し" }),
    el("th", { textContent: rows.length > 1 ? "元の値（1件目）" : "元の値" }),
    el("th", {}),
    el("th", { textContent: "Claude に送る値" })));
  for (const [i, c] of payload.columns.entries()) {
    const original = String(rows[0]?.[i] ?? "").trim();
    const others = c.samples.length > 1 ? [el("small", { className: "mask-others", textContent: `ほか${c.samples.length - 1}件も記号にします` })] : [];
    const value = c.withheld
      ? el("td", { className: "withheld", textContent: "送りません" })
      : el("td", { className: "symbol" }, c.samples[0] ?? "", ...others);
    const row = el("tr", {},
      el("td", { textContent: c.header }),
      el("td", { className: "mask-original", textContent: original || "（空）" }),
      el("td", { className: "mask-arrow", textContent: "→" }),
      value);
    row.classList.toggle("mask-more", i >= MASK_SHOWN);
    table.append(row);
  }
  $("payloadRaw").textContent = JSON.stringify(payload, null, 2);
  showMaskRows(false);
  // 計画書は見出しだけを読むので、値は見せず、送る見出しをここで一緒に見せる
  const planHeaders = state.slots.plan?.table.headers ?? [];
  $("maskPlanHeaders").hidden = planHeaders.length === 0;
  $("maskPlanHeaders").textContent = `個別避難計画書からは、見出しだけを読みます（値は送りません）：${planHeaders.join("、")}`;
}

// はじめは一部だけ見せ、押すと全部の列を見せる
const MASK_SHOWN = 5;
function showMaskRows(all) {
  const more = [...$("maskTable").querySelectorAll(".mask-more")];
  for (const row of more) row.hidden = !all;
  const total = more.length + MASK_SHOWN;
  $("maskAll").hidden = more.length === 0;
  $("maskAll").textContent = all ? "一部だけ表示する" : `すべて表示する（全${total}列）`;
  $("maskAll").onclick = () => showMaskRows(!all);
}

// 待っている間、一覧の元の値が送る記号へ変わっていく様子を見せる。送る中身は最初から記号だけで、これは画面の中の見せ方
const MORPH_GAP = 350;
function playMorph() {
  const { columns } = state.masked.payload;
  const rows = [...$("maskTable").querySelectorAll("tr")].slice(1);
  const visible = rows.filter((row) => !row.hidden).length;
  let order = 0;
  rows.forEach((row, i) => {
    const original = String(state.table.rows[0]?.[i] ?? "").trim();
    const cell = row.querySelector(".mask-original");
    const to = columns[i].withheld ? "送りません" : columns[i].samples[0] ?? "";
    cell.textContent = original || "（空）";
    if (row.hidden || !original || !to) return;
    const fromEl = el("span", { className: "morph-from", textContent: original });
    const toEl = el("span", { className: "morph-to", textContent: to });
    fromEl.style.animationDelay = toEl.style.animationDelay = `${order * Math.min(MORPH_GAP, 4000 / visible)}ms`;
    order += 1;
    cell.replaceChildren(el("span", { className: "morph-value" }, fromEl, toEl));
  });
  $("maskTable").scrollIntoView({ block: "nearest" });
  // 答えがすぐ返っても、ひと回りは見せる
  return new Promise((resolve) => setTimeout(resolve, order === 0 ? 0 : Math.min(MORPH_GAP * order, 4000) + 1000));
}

let columnsRequest = 0;
async function sendColumns() {
  columnsRequest += 1;
  const request = columnsRequest;
  showError($("sendError"), "");
  $("send").disabled = true;
  $("sendState").hidden = false;
  const firstRound = playMorph();
  try {
    const res = await fetch("/api/read-columns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.masked.payload),
    });
    const data = await res.json();
    await firstRound;
    if (request !== columnsRequest) return;
    if (!res.ok) throw new Error((data.errors ?? ["読み取れませんでした"]).join(" / "));
    state.results = data.results;
    $("modeNotice").hidden = data.mode !== "mock";
    $("modeNotice").textContent = "今は Claude につないでいません。見出しの言葉から作った仮の答えです。";
    state.careEdits = {};
    state.links = {};
    state.rowIndex = 0;
    state.whoChosen = undefined;
    renderCareWho();
    refreshDraft();
    // 様式を選んだあとで戻ってきたときは、その様式のままにする
    prepareFormat({ confirmed: true });
    goTo(4);
  } catch (e) {
    if (request === columnsRequest) showError($("sendError"), `送れませんでした。${e.message}`);
  } finally {
    if (request === columnsRequest) {
      $("send").disabled = false;
      $("sendState").hidden = true;
    }
  }
}

// ケアプランに複数の方がいるとき、どの方の計画を作るかを選ぶ
function renderCareWho() {
  const { rows } = state.table;
  $("whoRow").hidden = rows.length < 2;
  $("who").replaceChildren(...rows.map((row, i) => el("option", { value: String(i), textContent: `${i + 1}件目：${row[0] ?? ""}` })));
}

const careHeaders = () => state.table?.headers ?? state.imported?.input?.headers ?? [];

// ケアプランの列が、内側のどの項目に入るか。画面には出さない
function careTargetOf(header) {
  if (state.backToTalk) return state.imported?.input?.mapping?.[header] ?? "ignore";
  // 番号は持ち主ごとに別のものなので、つながない
  if (isOwnNumberColumn(header)) return "ignore";
  const read = state.results?.find((r) => r.header === header)?.target;
  return state.careEdits?.[header] ?? (read in TARGETS ? read : "unknown");
}

// 今の選択から、取り込みの対応を作る。strict のときは問題があれば理由を返す
function buildMapping({ strict = false } = {}) {
  const mapping = {};
  const used = new Map();
  for (const header of state.table?.headers ?? []) {
    const target = careTargetOf(header);
    if (target === "ignore") continue;
    if (target === "unknown") {
      if (strict) return { error: `「${header}」をどうするか選んでください。分からなければ「使わない」を選べます。` };
      continue;
    }
    // 足した欄の見出しは訪問のたびに送る。あとで止まると直す場所がない
    if (strict && target === "new" && suspiciousHeaders([header]).length > 0) return { error: `「${header}」は名前や番号と間違えやすいので、計画に無い欄にできません。「使わない」を選んでください。` };
    // 計画に無い欄は、列ごとに別の欄として足す
    if (strict && target !== "new" && used.has(target)) return { error: `「${header}」と「${used.get(target)}」が同じ列につながっています。` };
    used.set(target, header);
    mapping[header] = target;
  }
  return { mapping };
}

// 画面で値を見せるために、今の選択で計画を作り直す。訪問の途中では作り直さない
function refreshDraft() {
  if (state.backToTalk || !state.table) return;
  state.mapping = buildMapping().mapping;
  state.imported = freshImported();
}

// ケアプランの列と計画書の列を直接つなぐ。内側の項目は計画書の列に合わせる
function connectColumns(care, planHeader) {
  const target = currentColumns().find((c) => c.header === planHeader)?.target;
  delete state.links[care];
  for (const [other, linked] of Object.entries(state.links)) if (linked === planHeader) { delete state.links[other]; state.careEdits[other] = "ignore"; }
  if (!target || ["none", "unknown", "new"].includes(target)) {
    state.formatEdits ??= {};
    state.formatEdits[planHeader] = "new";
    state.careEdits[care] = "new";
    state.links[care] = planHeader;
    return;
  }
  const others = careHeaders().filter((h) => h !== care);
  const paths = expand(target);
  // 1列にまとめる列は、まだ空いている項目へ入れる。1項目の列は、前につないでいた列を外す
  const free = paths.find((p) => !others.some((h) => careTargetOf(h) === p)) ?? paths[paths.length - 1];
  if (paths.length === 1) for (const h of others) if (careTargetOf(h) === free) state.careEdits[h] = "ignore";
  state.careEdits[care] = free;
}

// 様式の見出しを、内容と結びつける。ここで人が確かめる
let formatRequest = 0;
async function chooseFormat(name, headers) {
  // 読んでいる間に戻ったり選び直したりしたら、古い答えは使わない
  formatRequest += 1;
  const request = formatRequest;
  showError($("formatError"), "");
  $("formatSend").hidden = true;
  $("formatNotice").hidden = true;
  $("formatGo").disabled = true;
  // 選んでいる様式を光らせ、読んでいる間は押せないようにする
  const choices = [$("formatDefault"), $("formatMint")];
  choices.forEach((b) => { b.disabled = true; });
  $("formatDefault").classList.toggle("primary", !headers);
  $("formatMint").classList.toggle("primary", name === "ミント市");
  $("formatState").hidden = !headers;
  try {
    const village = await loadVillage();
    let columns = defaultColumns(village);
    if (headers) {
      const res = await fetch("/api/read-columns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "output", columns: headers.map((header) => ({ header, withheld: false, samples: [] })) }),
      });
      const data = await res.json();
      if (request !== formatRequest) return;
      if (!res.ok) throw new Error((data.errors ?? ["読み取れませんでした"]).join(" / "));
      columns = data.results;
      $("formatNotice").hidden = data.mode !== "mock";
      $("formatNotice").textContent = "今は Claude につないでいません。見出しの言葉から作った仮の答えです。";
    }
    // 別の様式へ移ったら、前の様式の手直しは使わない
    if (state.formatName !== name) state.formatEdits = {};
    state.formatName = name;
    state.formatHeaders = headers;
    renderFormat(columns);
    $("formatGo").disabled = false;
  } catch (e) {
    if (request !== formatRequest) return;
    clearFlows();
    showError($("formatError"), `様式を読めませんでした。${e.message}`);
  } finally {
    if (request === formatRequest) {
      choices.forEach((b) => { b.disabled = false; });
      $("formatState").hidden = true;
    }
  }
}

function renderFormat(columns) {
  state.formatColumns = columns;
  state.formatOpen = new Set();
  refreshDraft();
  renderFormatWho();
  renderFlows();
}

// 人が手で直した選択は、様式を読み直しても残す
const currentColumns = () => (state.formatColumns ?? []).map(({ header, target }) => ({ header, target: isOwnNumberColumn(header) ? "meta.serial" : state.formatEdits?.[header] ?? (target in OUTPUT_TARGETS ? target : "unknown") }));

function clearFlows() {
  state.formatColumns = [];
  $("formatSummary").replaceChildren();
  $("formatTable").replaceChildren();
  $("formatBackNote").hidden = true;
}

const FLOW_GROUPS = [
  ["unknown", "選んでください", ""],
  ["care", "つながっている列", "ケアプラン"],
  ["plan", "計画書にだけ値がある列", "入れた計画書"],
  ["talk", "訪問で聞く列", "訪問で聞く"],
  ["hand", "手で入れる列", "手で入れる"],
  ["auto", "自動で入る列", ""],
  ["keep", "番号の列（触りません）", ""],
  ["none", "空のまま出す列", ""],
  ["left", "ケアプランだけの列（計画書には渡しません）", ""],
];
const FLOW_TABS = [["check", "確かめる"], ["linked", "つながっている"], ["talk", "訪問で聞く"], ["rest", "そのほか"]];
// 値が違う列と選んでほしい列を「確かめる」に集める
const tabOf = ({ kind, differs }) => (kind === "unknown" || differs ? "check" : kind === "care" || kind === "plan" ? "linked" : kind === "talk" || kind === "hand" ? "talk" : "rest");
const FLOW_PLAIN = { unknown: "選んでください", talk: "訪問で聞く", hand: "手元の情報に手で入れる", none: "入れません", keep: "ケアプランの番号は移しません", auto: "作成した日" };

// 列をつなぐ画面。左はケアプランの列と値、右は個別避難計画書の列と値
function renderFlows() {
  const columns = currentColumns();
  const data = activeFormatData();
  const who = Number($("formatWho").value);
  const input = state.imported?.input;
  const { rows } = describeFlows({
    columns,
    input,
    plan: state.imported?.plan,
    customs: state.imported?.customs,
    planHeaders: data?.headers,
    planRow: data && who >= 0 ? data.rows[who] : null,
  });

  // つながっている列と、ケアプランだけの列に分ける
  const valueOf = (header) => {
    const headers = state.table?.headers ?? input?.headers ?? [];
    const row = state.table ? state.table.rows[state.rowIndex] : input?.row;
    return String(row?.[headers.indexOf(header)] ?? "").trim();
  };
  const linkedTo = (column) => careHeaders().filter((h) => state.links?.[h] === column.header || (column.target !== "meta.serial" && expand(column.target).includes(careTargetOf(h))));
  for (const row of rows) row.lefts = row.kind === "keep" ? [] : linkedTo(row);
  const connected = new Set(rows.flatMap((r) => r.lefts));
  // 値が空でも、つないだ列は「つながっている列」に出す
  for (const row of rows) if (row.lefts.length > 0 && !["care", "unknown", "none"].includes(row.kind) && !row.talked) row.kind = "care";
  const leftOnly = careHeaders().filter((h) => !connected.has(h)).map((header) => {
    const target = careTargetOf(header);
    return { header, leftOnly: true, target, kind: target === "unknown" ? "unknown" : "left", lefts: [header], value: valueOf(header) };
  });
  const all = [...rows, ...leftOnly];

  const count = (kind) => rows.filter((r) => r.kind === kind).length;
  const sources = FLOW_GROUPS.filter(([kind, , label]) => label && count(kind) > 0).flatMap(([kind, , label], i) => [
    ...(i > 0 ? [el("span", { className: "flow-plus", textContent: "＋" })] : []),
    el("div", { className: `flow-source kind-${kind}` }, label, el("b", { textContent: `${count(kind)}列` })),
  ]);
  $("formatSummary").replaceChildren(...sources,
    el("span", { className: "flow-to-all", textContent: "→" }),
    el("div", { className: "flow-goal" }, "渡す個別避難計画書", el("b", { textContent: `${state.formatName}の様式 ${columns.length}列` })));

  const careName = state.slots.care?.name;
  const planName = data ? state.slots.plan?.name : `${state.formatName}の様式`;
  $("formatLegend").replaceChildren(
    el("b", { className: "legend-care", textContent: "左：ケアプランの列と値" }), careName ? `（${careName}）` : "",
    el("span", { className: "legend-gap", textContent: "／" }),
    el("b", { textContent: "右：個別避難計画書の列と値" }), planName ? `（${planName}）` : "");

  // タブごとに列を分ける。はじめは確かめるところだけを出す。「そのほか」の方は全部を並べる
  const everything = document.body.dataset.role === "other";
  // 直した列が別のタブへ移ったら、その列が見えるタブへ移る
  const followed = state.flowFollow && all.find((r) => `${r.leftOnly ? "care" : "plan"}:${r.header}` === state.flowFollow);
  if (followed) state.flowTab = tabOf(followed);
  state.flowFollow = null;
  state.flowTab ??= "check";
  $("flowTabs").hidden = everything;
  $("flowTabs").replaceChildren(...FLOW_TABS.map(([key, label]) => {
    const button = el("button", { className: `tab${key === state.flowTab ? " current" : ""}`, type: "button" }, label, el("small", { textContent: `${all.filter((r) => tabOf(r) === key).length}列` }));
    button.setAttribute("aria-pressed", String(key === state.flowTab));
    button.addEventListener("click", () => {
      state.flowTab = key;
      renderFlows();
    });
    return button;
  }));
  const visible = everything ? all : all.filter((r) => tabOf(r) === state.flowTab);
  const inGroup = (row, kind) => (kind === "differs" ? row.kind === "care" && row.differs : row.kind === kind && !(kind === "care" && row.differs));
  const groups = [["differs", "値が違う列"], ...FLOW_GROUPS].filter(([kind]) => visible.some((r) => inGroup(r, kind)));
  const empty = visible.length === 0 ? [el("p", { className: "tab-empty", textContent: "確かめるところはありません。このまま進めます。" })] : [];
  $("formatTable").replaceChildren(...empty, ...groups.map(([kind, title]) => el("section", { className: `flow-group kind-${kind === "differs" ? "talk" : kind}` },
    el("h3", { className: "flow-head" }, title, el("small", { textContent: `${visible.filter((r) => inGroup(r, kind)).length}列` })),
    el("div", { className: "flow-list" }, ...visible.filter((r) => inGroup(r, kind)).map((row) => flowRow(row, valueOf, columns))))));

  // 計画書のファイルをつないでいるときは、別の様式を選ぶと値が使えないので、選ぶところを出さない
  $("formatChoices").hidden = Boolean(data);
  $("formatBackNote").hidden = !input;
}

const option = (value, textContent) => el("option", { value, textContent });

// 直す選択肢。相手の列を先に出し、そのほかの扱いを後ろに出す
function rowOptions(row, columns) {
  const select = el("select", { ariaLabel: `${row.header} のつなぎ先` });
  const canLink = !state.backToTalk;
  if (row.leftOnly) {
    const targets = columns.filter((c) => !c.target.startsWith("meta.") && !c.target.startsWith("helper") && !isOwnNumberColumn(c.header));
    if (canLink) select.append(Object.assign(el("optgroup", { label: "計画書の列につなぐ" }), {}));
    if (canLink) select.lastChild.append(...targets.map((c) => option(`plan:${c.header}`, c.header)));
    const rest = el("optgroup", { label: "そのほか" });
    rest.append(...Object.entries(TARGETS).map(([value, label]) => option(value, label)));
    if (row.target in TARGETS) select.append(rest);
    else select.append(rest, option(row.target, "今の項目のまま"));
    select.value = row.target;
    return select;
  }
  const lefts = careHeaders().filter((h) => !isOwnNumberColumn(h));
  if (canLink && lefts.length > 0) {
    const group = el("optgroup", { label: "ケアプランの列につなぐ" });
    group.append(...lefts.map((h) => option(`care:${h}`, h)));
    select.append(group);
  }
  const rest = el("optgroup", { label: "そのほか" });
  rest.append(...Object.entries({ ...OUTPUT_TARGETS, unknown: "分からない（選んでください）" }).map(([value, label]) => option(value, label)));
  select.append(rest);
  select.value = canLink && row.lefts.length === 1 ? `care:${row.lefts[0]}` : row.target;
  return select;
}

function flowRow(row, valueOf, columns) {
  const { header, kind, target } = row;
  const key = `${row.leftOnly ? "care" : "plan"}:${header}`;
  const select = rowOptions(row, columns);
  select.dataset.key = key;
  const isOpen = kind === "unknown" || state.formatOpen?.has(key);
  select.hidden = !isOpen;
  select.addEventListener("change", () => {
    const [how, other] = select.value.startsWith("care:") || select.value.startsWith("plan:") ? [select.value.slice(0, 4), select.value.slice(5)] : [null, null];
    state.formatEdits ??= {};
    state.careEdits ??= {};
    state.links ??= {};
    if (how === "care") connectColumns(other, header);
    else if (how === "plan") connectColumns(header, other);
    else if (row.leftOnly) {
      delete state.links[header];
      state.careEdits[header] = select.value;
    } else {
      state.formatEdits[header] = select.value;
      // つないでいた列は外し、もとの読み取りに戻す
      for (const h of row.lefts) {
        delete state.links[h];
        delete state.careEdits[h];
      }
    }
    state.formatOpen.add(key);
    state.flowFollow = key;
    refreshDraft();
    renderFormatWho();
    renderFlows();
    // 選び直した行は別のまとまりへ移るので、押していた場所を見失わないようにする
    const moved = [...$("formatTable").querySelectorAll("select")].find((s) => s.dataset.key === key);
    moved?.focus();
    moved?.closest(".flow-row").scrollIntoView({ block: "nearest" });
  });
  const edit = el("button", { className: "button mini", type: "button", textContent: "直す" });
  // 番号の列は直せない。訪問の途中はケアプランの列をつなぎ直さない
  const ownNumber = isOwnNumberColumn(header);
  edit.hidden = isOpen || ownNumber || (row.leftOnly && state.backToTalk);
  edit.addEventListener("click", () => {
    state.formatOpen.add(key);
    select.hidden = false;
    edit.hidden = true;
    select.focus();
  });
  const pair = (name, value) => [el("span", { textContent: name }), el("span", { className: "value", textContent: value || "（空）" })];
  const left = row.talked
    ? pair("訪問で聞いた値", row.talked.join("、"))
    : row.lefts.length > 0
      ? row.lefts.flatMap((h) => pair(h, valueOf(h)))
      : [el("span", { className: "plain", textContent: kind === "plan" ? "ケアプランにはありません" : FLOW_PLAIN[kind] })];
  const right = row.leftOnly
    ? [el("span", { className: "plain", textContent: kind === "unknown" ? "つなぐ先を選んでください" : ownNumber ? "番号は触りません" : "計画書には渡しません" })]
    : [el("span", { className: "flow-name", textContent: header }), ...(row.incoming ? [el("span", { className: "value", textContent: row.incoming })] : [])];
  return el("div", { className: "flow-row" },
    el("div", { className: "flow-from" }, ...left),
    el("span", { className: "flow-arrow", textContent: kind === "care" ? "⇄" : "→" }),
    el("div", { className: "flow-to" }, ...right),
    edit,
    ...(row.differs ? [el("div", { className: "flow-differs", textContent: "値が違います。次の画面で扱いを選びます。" })] : []),
    select);
}

// 今の様式と同じファイルの値だけを使う。訪問の途中では見出しだけを使う
const activeFormatData = () => (state.formatData?.name === state.formatName && state.formatData.rows.length > 0 && !state.backToTalk ? state.formatData : null);
const formatTargets = () => Object.fromEntries(currentColumns().map((c) => [c.header, c.target]));

// 計画書のどの行を使うか。本人と一致する行が1つに決まれば選んでおき、決まらなければ入れないままにする
function renderFormatWho() {
  const data = activeFormatData();
  $("formatWhoRow").hidden = !data;
  if (!data) return;
  const targets = formatTargets();
  const nameAt = data.headers.findIndex((h) => targets[h] === "self.name");
  const identity = state.imported?.identity ?? {};
  const hit = findPersonRow(data, targets, identity);
  // 比べる相手がなく1行だけなら、その行で始める
  // 人が選んだ行は、列の対応を直しても変えない
  const chosen = state.whoChosen ?? hit ?? (!identity["self.name"] && data.rows.length === 1 ? 0 : -1);
  $("formatWho").replaceChildren(
    el("option", { value: "-1", textContent: "値を入れない（見出しだけ使う）" }),
    ...data.rows.map((row, i) => el("option", { value: String(i), textContent: `${i + 1}件目：${nameAt >= 0 ? row[nameAt] ?? "" : ""}` })),
  );
  $("formatWho").value = String(chosen);
  $("formatWhoNote").textContent = hit !== null ? "ケアプランの方と同じ名前の行です。" : identity["self.name"] ? "ケアプランの方と同じ名前の行が見つかりません。同じ方なら選んでください。" : "";
}

function renderMerge(merge) {
  $("mergeBox").hidden = !merge;
  if (!merge) return;
  const { conflicts, unread, helpers } = merge;
  const conflictRows = conflicts.map((c) => {
    const select = el("select", { ariaLabel: `${c.label} の扱い` });
    select.append(
      el("option", { value: "ask", textContent: "今回の聞き取りで確かめる（欄は空にします）" }),
      el("option", { value: "current", textContent: `ケアプランの値を使う：${c.current}` }),
      el("option", { value: "incoming", textContent: `計画書の値を使う：${c.incoming}` }),
    );
    select.value = (state.imported.rechecks ?? []).some((r) => r.key === c.key) ? "ask" : "current";
    select.addEventListener("change", () => {
      chooseConflict(state.imported, c, select.value);
      renderResult(state.imported);
    });
    return el("div", { className: "merge-conflict" }, el("span", { textContent: `${c.label}が違います` }), select);
  });
  $("mergeConflicts").replaceChildren(...(conflictRows.length ? [el("p", { className: "merge-conflict-note", textContent: "どちらが今の情報か分からないときは、ご本人に確かめます。" })] : []), ...conflictRows);
  const notes = [];
  if (helpers.length > 0) notes.push(`入れた計画書に手伝う人がいます（${helpers.join("、")}）。今も頼めるかを話の中で確かめ、印を付けてください。`);
  if ((state.imported.leftovers ?? []).length > 0) notes.push(`1列にまとめて書かれていた文は、欄に分けず手元に残しました：${state.imported.leftovers.map((l) => l.label).join("、")}`);
  if (unread.length > 0) notes.push(`形を読めなかったので入れていません：${unread.join("、")}`);
  $("mergeNotes").replaceChildren(...notes.map((n) => el("li", { textContent: n })));
  // 知らせることが無ければ枠ごと出さない
  $("mergeBox").hidden = conflicts.length === 0 && notes.length === 0;
}

async function confirmFormat() {
  showError($("formatError"), "");
  // 画面は元ごとにまとめて見せるので、並びは画面からとらず、様式の順番のまま渡す
  const columns = currentColumns();
  const unknown = columns.find((c) => c.target === "unknown");
  if (unknown) {
    showError($("formatError"), `「${unknown.header}」に入れる内容を選んでください。分からなければ「空のまま出す」を選べます。`);
    state.flowTab = "check";
    renderFlows();
    return;
  }
  if (!state.backToTalk && state.table) {
    const { mapping, error } = buildMapping({ strict: true });
    if (error) {
      showError($("formatError"), error);
      state.flowTab = "check";
      renderFlows();
      return;
    }
    state.mapping = mapping;
  }
  const village = await loadVillage();
  // 選び直しても前の値が混ざらないよう、訪問の前は入口の値から作り直して入れる
  const data = activeFormatData();
  if (!state.backToTalk) state.imported = freshImported();
  attachOutput(state.imported, {
    base: village,
    name: state.formatName,
    columns,
  });
  const who = Number($("formatWho").value);
  const merge = data && who >= 0
    ? mergeOutputRow(state.imported, { headers: data.headers, row: data.rows[who], targets: state.imported.output.targets, blankValue: state.imported.output.blankValue })
    : null;
  // 違う値は、どちらかを黙って使わず、今回の聞き取りで確かめるところから始める
  for (const conflict of merge?.conflicts ?? []) chooseConflict(state.imported, conflict, "ask");
  // 訪問の途中で変えたときは、話の画面へ戻る
  if (state.backToTalk) {
    const fromWrap = state.fromWrap;
    state.imported.refreshFormat();
    closeFormat();
    // 訪問終了の画面から開いたときは、待たずに新しい様式で開き直す。遅れて届いた点検はあとから入る
    if (fromWrap) {
      state.imported.skipWrapWait = true;
      $("goWrap").click();
    }
    return;
  }
  renderResult(state.imported);
  renderMerge(merge);
  goTo(5);
}

// 今の様式を開き直す。足した欄は「計画に無い欄」として見せる
function reopenFormat() {
  const { output, customs = [] } = state.imported;
  $("formatSend").hidden = true;
  const fromExtra = (target) => (customs.some((c) => c.path === target) ? "new" : target);
  state.formatName = output.name ?? "ハッカ村";
  renderFormat(output.columns.map((header) => ({ header, target: fromExtra(output.targets[header]) })));
  $("formatDefault").classList.toggle("primary", state.formatName === "ハッカ村");
  $("formatMint").classList.toggle("primary", state.formatName === "ミント市");
  $("formatNotice").hidden = true;
  showError($("formatError"), "");
  $("formatGo").disabled = false;
}

// 訪問の途中から様式の画面を開く。話した内容はそのまま
function openFormat() {
  state.backToTalk = true;
  state.fromWrap = !$("wrap").hidden;
  reopenFormat();
  $("talk").hidden = true;
  $("wrap").hidden = true;
  $("step4").hidden = false;
  document.body.classList.remove("wide-mode");
  window.scrollTo(0, 0);
}

function closeFormat() {
  state.backToTalk = false;
  state.fromWrap = false;
  document.querySelector(".top h1").textContent = "訪問";
  document.querySelector(".top p").textContent = "話を聞いて、段取りと次の一歩を決めます。決めるのはご本人です。";
  $("step4").hidden = true;
  $("talk").hidden = false;
  document.body.classList.add("wide-mode");
  window.scrollTo(0, 0);
}

function renderResult({ identity, plan, notes }) {
  const known = [
    ["氏名", identity["self.name"]],
    ["ふりがな", identity["self.kana"]],
    ["生年月日", identity["self.birth"]],
    ["住所", identity["self.address"]],
    ["電話", identity["self.phone"]],
    ["要介護度", plan.care.level.value],
    ["歩き方", plan.care.mobility.value],
    ["階段", plan.care.stairs.value],
    ["聞こえ方", plan.care.hearing.value],
    ["普段いる部屋", plan.home.usualRoom.value],
    ["寝室", plan.home.bedroom.value],
    ["同居", plan.care.household.value],
    ["危険個所", plan.home.hazardNote.value],
    ["緊急連絡先", identity["emergency.name"]],
    ["備考", notes],
  ].filter(([, v]) => v);
  $("known").replaceChildren(...known.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: v })]));

  const isFilled = (path) => path.split(".").reduce((o, k) => o?.[k], plan)?.status === "filled";
  const topics = TALK_TOPICS.filter(([, paths]) => paths.length === 0 || !paths.every(isFilled)).map(([text]) => text);
  for (const { label } of pendingRechecks(state.imported).reverse()) topics.unshift(`${label}（2つのデータで違うので確かめる）`);
  if (!plan.care.mobility.value) topics.unshift("歩き方や、避難のときに気をつけること");
  if (!identity["emergency.name"]) topics.unshift("もしものときの連絡先");
  const gaps = serviceGaps(plan);
  if (gaps?.length) topics.unshift(`${gaps.join("・")}の昼の過ごし方`);
  if (gaps === null) topics.unshift("1週間の過ごし方");
  $("toTalk").replaceChildren(...topics.map((t) => el("li", { textContent: t })));

  renderWeek(plan, gaps);
  renderChecks(identity, plan);
}

function renderWeek(plan, gaps) {
  const items = plan.care.weekly.value?.items ?? [];
  const wrap = $("week");
  if (items.length === 0) {
    const unread = plan.care.weekly.value?.unread?.length > 0;
    wrap.replaceChildren(el("p", { className: "hint", textContent: unread ? "サービスの予定を読めなかったので、話の中で聞きます。" : "サービスの予定が CSV に無いので、話の中で聞きます。" }));
    return;
  }
  const days = WEEK.map((d) => {
    const here = items.filter((i) => i.days.includes(d));
    const isGap = gaps?.includes(d);
    const className = `day ${here.length ? "covered" : isGap ? "gap" : ""}`;
    const text = here.length ? here.map((i) => `${i.kind} ${i.start}〜${i.end}`).join(" ") : isGap ? "昼はどなたが？" : "サービスなし";
    return el("div", { className }, el("b", { textContent: d }), text);
  });
  wrap.replaceChildren(el("div", { className: "week-wrap" }, el("div", { className: "week" }, ...days)));
}

function renderChecks(identity, plan) {
  const notes = [];
  const phone = identity["self.phone"];
  if (phone && (phone.length < 10 || phone.length > 11)) notes.push("ご本人の電話番号の桁数を確かめてください。");
  if (Object.hasOwn(identity, "self.birth") && !identity["self.birth"]) notes.push("生年月日を読み取れませんでした。");
  if (Object.hasOwn(identity, "self.postal") && !identity["self.postal"]) notes.push("郵便番号の桁数を確かめてください。");
  for (const part of plan.care.weekly.value?.unread ?? []) notes.push(`読めなかった予定があります：${part}`);
  $("checks").replaceChildren(...notes.map((n) => el("p", { className: "notice", textContent: n })));
}

for (const [id, key] of [["file", "care"], ["planFile", "plan"]]) {
  $(id).addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (files.length > 0) takeFiles(key, files);
  });
}
const putSample = async (key, name) => {
  const res = await fetch(`/samples/${name}`);
  putSlot(key, name, new Uint8Array(await res.arrayBuffer()));
};
document.querySelectorAll("[data-sample]").forEach((b) => b.addEventListener("click", () => putSample("care", b.dataset.sample)));
document.querySelectorAll("[data-plan-sample]").forEach((b) => b.addEventListener("click", () => putSample("plan", b.dataset.planSample)));
document.querySelectorAll(".slot").forEach((box) => {
  const key = box.dataset.slot;
  box.querySelector(".slot-remove").addEventListener("click", () => {
    state.slots[key] = null;
    showError($("fileError"), "");
    renderSlots();
  });
  box.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    box.classList.add("over");
  });
  box.addEventListener("dragleave", (e) => {
    if (!box.contains(e.relatedTarget)) box.classList.remove("over");
  });
  box.addEventListener("drop", (e) => {
    box.classList.remove("over");
    if (e.dataTransfer?.files.length > 0) takeFiles(key, e.dataTransfer.files);
  });
});
// 枠の外に落としても、ブラウザがファイルを開いて入力が消えないようにする
for (const type of ["dragover", "drop"]) {
  window.addEventListener(type, (e) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  });
}
$("swapSlots").addEventListener("click", () => {
  const { care, plan } = state.slots;
  if (plan && plan.table.rows.length === 0) {
    showError($("fileError"), "見出しだけのファイルはケアプランの側に入れられません。");
    return;
  }
  showError($("fileError"), "");
  state.slots = { care: plan, plan: care };
  renderSlots();
});
// 使う人を選ぶと、その人に要るものだけを出す
function chooseRole(role) {
  document.body.dataset.role = role;
  document.querySelectorAll("[data-role-choice]").forEach((b) => b.classList.toggle("primary", b.dataset.roleChoice === role));
  // どちらも相手のデータを受け取っている前提で、自分の分と受け取った分を示す
  const whose = {
    care: ["あなたのデータ", "民生委員から受け取ったデータ"],
    minsei: ["ケアマネジャーから受け取ったデータ", "あなたのデータ"],
  }[role] ?? ["", ""];
  ["slotCare", "slotPlan"].forEach((id, i) => {
    const note = $(id).querySelector(".slot-whose");
    note.textContent = whose[i];
    note.hidden = !whose[i];
  });
  showError($("fileError"), "");
  renderSlots();
}
document.querySelectorAll("[data-role-choice]").forEach((b) => b.addEventListener("click", () => chooseRole(b.dataset.roleChoice)));
$("connect").addEventListener("click", connect);
const backToStart = () => {
  columnsRequest += 1;
  $("send").disabled = false;
  $("sendState").hidden = true;
  goTo(1);
};
$("sendBack").addEventListener("click", backToStart);
$("send").addEventListener("click", sendColumns);
$("formatDefault").addEventListener("click", () => chooseFormat("ハッカ村", null));
$("formatMint").addEventListener("click", async () => {
  try {
    const res = await fetch("/samples/mint-city.format.csv");
    chooseFormat("ミント市", parseCsv(decodeCsv(new Uint8Array(await res.arrayBuffer()))).headers);
  } catch {
    showError($("formatError"), "様式を読めませんでした。もう一度押してください。");
  }
});
$("formatFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const { table, error } = readTable(new Uint8Array(await file.arrayBuffer()), { needRows: false });
  if (error) {
    formatRequest += 1;
    $("formatGo").disabled = true;
    clearFlows();
    showError($("formatError"), error);
    return;
  }
  takeFormat(file.name, table);
});
$("formatWho").addEventListener("change", () => {
  state.whoChosen = Number($("formatWho").value);
  renderFlows();
});
$("formatGo").addEventListener("click", confirmFormat);
$("formatBack").addEventListener("click", () => {
  // 読んでいる途中の答えは使わない
  formatRequest += 1;
  $("formatState").hidden = true;
  $("formatDefault").disabled = false;
  $("formatMint").disabled = false;
  if (state.fromWrap) {
    // 訪問終了の画面から開いたときは、そこへ戻す
    state.backToTalk = false;
    state.fromWrap = false;
    document.querySelector(".top h1").textContent = "訪問終了";
    document.querySelector(".top p").textContent = "今日できたことを確かめて、ご本人に共有する紙と、渡すものを作ります。";
    $("step4").hidden = true;
    $("wrap").hidden = false;
    document.body.classList.add("wide-mode");
    window.scrollTo(0, 0);
  } else if (state.backToTalk) closeFormat();
  else goTo(state.table ? 2 : 1);
});
$("stepFormat").addEventListener("click", () => {
  reopenFormat();
  goTo(4);
});
$("changeFormat").addEventListener("click", openFormat);
$("wrapFormat").addEventListener("click", openFormat);
$("who").addEventListener("change", () => {
  state.rowIndex = Number($("who").value) || 0;
  // 別の方を選び直したら、計画書の行も選び直す
  state.whoChosen = undefined;
  refreshDraft();
  renderFormatWho();
  renderFlows();
});
$("startTalk").addEventListener("click", () => beginTalk(state.imported));

$("manualForm").append(...MANUAL_FIELDS.map(([key, label]) => el("label", { className: "field-label" }, label, el("input", { className: "plan-input", name: key }))));
$("manualStart").addEventListener("click", () => {
  $("manual").hidden = false;
  $("manual").scrollIntoView({ behavior: "smooth", block: "nearest" });
});
$("manualForm").addEventListener("submit", (e) => e.preventDefault());
$("manualGo").addEventListener("click", () => {
  const form = new FormData($("manualForm"));
  const headers = MANUAL_FIELDS.map(([key]) => key);
  const mapping = Object.fromEntries(headers.map((h) => [h, h]));
  const imported = importRow({ headers, row: headers.map((h) => String(form.get(h) ?? "")), mapping, source: "human" });
  // 読めない値を黙って空にしない
  const unreadable = MANUAL_FIELDS.filter(([key]) => key in imported.identity && String(form.get(key) ?? "").trim() && !imported.identity[key]).map(([, label]) => label);
  const unreadWeek = imported.plan.care.weekly.value?.unread?.length ? ["週のサービス"] : [];
  if (unreadable.length + unreadWeek.length > 0) {
    showError($("fileError"), `読み取れない値があります。形を直すか、空にしてください：${[...unreadable, ...unreadWeek].join("、")}`);
    $("fileError").scrollIntoView({ block: "nearest" });
    return;
  }
  showError($("fileError"), "");
  beginTalk(imported);
});
$("resume").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    beginTalk(checkResumedFormat(fromResumeFile(JSON.parse(await file.text()))));
  } catch (err) {
    showError($("fileError"), `読み込めませんでした。${err instanceof SyntaxError ? "続き用ファイルの形ではありません。" : err.message}`);
  }
});
document.querySelectorAll("[data-quick]").forEach((b) => b.addEventListener("click", async () => {
  const name = b.dataset.quick;
  const [bytes, mapping, script] = await Promise.all([
    fetch(`/samples/keahakka_${name}.csv`).then((r) => r.arrayBuffer()),
    fetch("/samples/keahakka.mapping.json").then((r) => r.json()),
    fetch(`/samples/${name}.script.json`).then((r) => r.json()),
  ]);
  const table = parseCsv(decodeCsv(new Uint8Array(bytes)));
  beginTalk(importRow({ headers: table.headers, row: table.rows[0], mapping }), { script });
}));
const configReady = fetch("/api/config").then((r) => r.json()).then(({ publicDemo }) => {
  if (!publicDemo) return;
  // 公開デモでも CSV は入れられる。値はブラウザの中だけなので、架空のデータを入れてもらうよう入口で伝える
  $("resume").closest("label").hidden = true;
  $("manualStart").hidden = true;
  document.querySelectorAll(".slot-drop").forEach((p) => { p.textContent = "架空のデータの CSV をここにドラッグ"; });
}).catch(() => {});
renderSlots();
goTo(1);
