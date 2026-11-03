// 取り込みの画面。本物の値はこの画面の中だけで扱い、サーバーへは記号だけを送る
import { decodeCsv, parseCsv } from "/core/csv.js";
import { maskTable } from "/core/mask.js";
import { findLeaks } from "/core/redact.js";
import { attachOutput, checkResumedFormat, DEFAULT_TARGETS, duplicateHeaders, isOwnNumberColumn, OUTPUT_TARGETS, suspiciousHeaders } from "/core/format.js";
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
  ["大雨の夜の様子と、心配な災害", ["hazards.items"]],
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
  for (const id of ["step1", "step2", "step3", "step4", "step5", "manual"]) $(id).hidden = true;
  document.querySelector(".steps").hidden = true;
  document.body.classList.remove("home");
  document.body.classList.add("wide-mode");
  document.querySelector(".top h1").textContent = "訪問";
  document.querySelector(".top p").textContent = "話を聞いて、段取りと次の一歩を決めます。決めるのはご本人です。";
  startTalk(imported, options);
}

function goTo(step) {
  // 終わった段階は積み重ねず、今の段階だけを見せる
  for (let i = 1; i <= 5; i++) {
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
  if (state.publicDemo) {
    showError($("fileError"), "公開版では実在のデータが入らないよう、架空の見本だけ使えます。");
    return;
  }
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
  return importRow({ headers: state.table.headers, row: state.table.rows[state.rowIndex], mapping: state.mapping });
}

// 計画書のファイルがあれば、その見出しで様式を読む。無ければ今の様式のまま
function prepareFormat() {
  const plan = state.slots.plan;
  if (plan && state.formatTaken !== plan) {
    state.formatTaken = plan;
    takeFormat(plan.name, plan.table);
    return;
  }
  if (!plan) {
    state.formatTaken = null;
    state.formatData = null;
  }
  chooseFormat(state.formatName ?? "ハッカ村", state.formatHeaders ?? null);
}

// 様式の見出しと値を受け取る。見出しは Claude へ送る前に見せ、値は手元に残す
async function takeFormat(fileName, { headers, rows }) {
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

let columnsRequest = 0;
async function sendColumns() {
  columnsRequest += 1;
  const request = columnsRequest;
  showError($("sendError"), "");
  $("send").disabled = true;
  $("sendState").hidden = false;
  try {
    const res = await fetch("/api/read-columns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.masked.payload),
    });
    const data = await res.json();
    if (request !== columnsRequest) return;
    if (!res.ok) throw new Error((data.errors ?? ["読み取れませんでした"]).join(" / "));
    state.results = data.results;
    $("modeNotice").hidden = data.mode !== "mock";
    $("modeNotice").textContent = "今は Claude につないでいません。見出しの言葉から作った仮の答えです。";
    renderConfirm();
    goTo(3);
  } catch (e) {
    if (request === columnsRequest) showError($("sendError"), `送れませんでした。${e.message}`);
  } finally {
    if (request === columnsRequest) {
      $("send").disabled = false;
      $("sendState").hidden = true;
    }
  }
}

function renderConfirm() {
  const { headers, rows } = state.table;
  $("whoRow").hidden = rows.length < 2;
  $("who").replaceChildren(...rows.map((row, i) => el("option", { value: String(i), textContent: `${i + 1}件目：${row[0] ?? ""}` })));
  const fileName = state.slots.care?.name;
  $("confirmLegend").textContent = `読み込んだケアプラン：${fileName ?? ""}`;
  // 2列に並ぶので、列の上にそれぞれ「左は何か、右は何か」を出す
  const legend = () => el("div", { className: "flow-row confirm-row confirm-legend" },
    el("div", { className: "kind-care confirm-from" }, el("b", { textContent: "ケアプランの列" }), rows.length > 1 ? "と1件目の値" : "と値"),
    el("span", { className: "flow-arrow", textContent: "→" }),
    el("div", { className: "confirm-to" }, el("b", { textContent: "この道具の計画の欄" })));
  const table = $("confirmTable");
  table.replaceChildren(legend(), Object.assign(legend(), { className: "flow-row confirm-row confirm-legend confirm-legend-second" }));
  state.results.forEach((r) => {
    const col = headers.indexOf(r.header);
    const select = el("select", { "ariaLabel": `${r.header} の欄` });
    select.dataset.header = r.header;
    for (const [value, label] of Object.entries(TARGETS)) select.append(el("option", { value, textContent: label }));
    select.value = r.target in TARGETS ? r.target : "unknown";
    // 番号は持ち主ごとに別のものなので、計画につながない
    const ownNumber = isOwnNumberColumn(r.header);
    if (ownNumber) {
      select.value = "ignore";
      select.disabled = true;
    }
    const kind = () => (select.value === "unknown" ? "kind-unknown" : "kind-care");
    const original = String(rows[0]?.[col] ?? "").trim();
    const row = el("div", { className: `flow-row confirm-row ${ownNumber ? "kind-keep" : kind()}` },
      el("div", { className: "flow-from" }, el("span", { textContent: r.header }), el("span", { className: "value", textContent: original || "（空）" })),
      el("span", { className: "flow-arrow", textContent: "→" }),
      el("div", {}, select, ...(ownNumber ? [el("small", { className: "own-number", textContent: "番号は触りません" })] : [])));
    select.addEventListener("change", () => {
      row.classList.toggle("kind-unknown", select.value === "unknown");
      row.classList.toggle("kind-care", select.value !== "unknown");
    });
    table.append(row);
  });
}

function confirmMapping() {
  showError($("confirmError"), "");
  const selects = [...$("confirmTable").querySelectorAll("select")];
  const mapping = {};
  const used = new Map();
  for (const s of selects) {
    if (s.value === "unknown") {
      showError($("confirmError"), `「${s.dataset.header}」の欄を選んでください。分からなければ「使わない」を選べます。`);
      return;
    }
    if (s.value === "ignore") continue;
    // 足した欄の見出しは訪問のたびに送る。あとで止まると直す場所がない
    if (s.value === "new" && suspiciousHeaders([s.dataset.header]).length > 0) {
      showError($("confirmError"), `「${s.dataset.header}」は名前や番号と間違えやすいので、計画に無い欄にできません。「使わない」を選んでください。`);
      return;
    }
    // 計画に無い欄は、列ごとに別の欄として足す
    if (s.value !== "new" && used.has(s.value)) {
      showError($("confirmError"), `「${s.dataset.header}」と「${used.get(s.value)}」が同じ欄になっています。`);
      return;
    }
    used.set(s.value, s.dataset.header);
    mapping[s.dataset.header] = s.value;
  }
  state.mapping = mapping;
  state.rowIndex = Number($("who").value) || 0;
  // 別の方を選び直したら、計画書の行も選び直す
  state.whoChosen = undefined;
  state.imported = freshImported();
  // 様式を選んだあとで選び直したときは、その様式のままにする
  prepareFormat();
  goTo(4);
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
  renderFormatWho();
  renderFlows();
}

// 人が手で直した選択は、様式を読み直しても残す
const currentColumns = () => (state.formatColumns ?? []).map(({ header, target }) => ({ header, target: isOwnNumberColumn(header) ? "meta.serial" : state.formatEdits?.[header] ?? (target in OUTPUT_TARGETS ? target : "unknown") }));

function clearFlows() {
  state.formatColumns = [];
  $("formatSummary").replaceChildren();
  $("formatTable").replaceChildren();
  $("formatUnused").hidden = true;
  $("formatBackNote").hidden = true;
}

const FLOW_GROUPS = [
  ["unknown", "選んでください", ""],
  ["care", "ケアプランから渡す", "ケアプラン"],
  ["plan", "入れた計画書から渡す", "入れた計画書"],
  ["talk", "訪問で聞いて渡す", "訪問で聞く"],
  ["hand", "手で入れて渡す", "手で入れる"],
  ["auto", "自動で入る", ""],
  ["keep", "番号はそのまま（触りません）", ""],
  ["none", "空のまま出す", ""],
];
const FLOW_PLAIN = { unknown: "入れる内容が分かりません", talk: "訪問で聞く", hand: "手元の情報に手で入れる", none: "入れません", keep: "空のまま（番号は付けません）", auto: "作成した日" };

// 渡す様式の見え方：元 → 渡す先。直すときだけ選択肢を開く
function renderFlows() {
  const columns = currentColumns();
  const data = activeFormatData();
  const who = Number($("formatWho").value);
  const { rows, unused } = describeFlows({
    columns,
    input: state.imported?.input,
    plan: state.imported?.plan,
    planHeaders: data?.headers,
    planRow: data && who >= 0 ? data.rows[who] : null,
  });

  const count = (kind) => rows.filter((r) => r.kind === kind).length;
  const sources = FLOW_GROUPS.filter(([kind, , label]) => label && count(kind) > 0).flatMap(([kind, , label], i) => [
    ...(i > 0 ? [el("span", { className: "flow-plus", textContent: "＋" })] : []),
    el("div", { className: `flow-source kind-${kind}` }, label, el("b", { textContent: `${count(kind)}列` })),
  ]);
  $("formatSummary").replaceChildren(...sources,
    el("span", { className: "flow-to-all", textContent: "→" }),
    el("div", { className: "flow-goal" }, "渡す個別避難計画書", el("b", { textContent: `${state.formatName}の様式 ${columns.length}列` })));

  $("formatTable").replaceChildren(...FLOW_GROUPS.filter(([kind]) => count(kind) > 0).map(([kind, title]) => el("section", { className: `flow-group kind-${kind}` },
    el("h3", { className: "flow-head" }, title, el("small", { textContent: `${count(kind)}列` })),
    el("div", { className: "flow-list" }, ...rows.filter((r) => r.kind === kind).map(flowRow)))));

  $("formatUnused").hidden = unused.length === 0;
  $("formatUnused").textContent = `ケアプランにあるけれど計画書へ渡さない列：${unused.join("、")}`;
  $("formatBackNote").hidden = !state.imported?.input;
}

function flowRow(row) {
  const { header, kind, target } = row;
  const select = el("select", { ariaLabel: `${header} に入れる内容` });
  select.dataset.header = header;
  for (const [value, label] of Object.entries({ ...OUTPUT_TARGETS, unknown: "分からない（選んでください）" })) select.append(el("option", { value, textContent: label }));
  select.value = target;
  const open = kind === "unknown" || state.formatOpen?.has(header);
  select.hidden = !open;
  select.addEventListener("change", () => {
    state.formatEdits ??= {};
    state.formatEdits[header] = select.value;
    state.formatOpen.add(header);
    renderFormatWho();
    renderFlows();
    // 選び直した行は別のまとまりへ移るので、押していた場所を見失わないようにする
    const moved = [...$("formatTable").querySelectorAll("select")].find((s) => s.dataset.header === header);
    moved?.focus();
    moved?.closest(".flow-row").scrollIntoView({ block: "nearest" });
  });
  const edit = el("button", { className: "button mini", type: "button", textContent: "直す" });
  // 番号の列は直せない。そのまま残すだけ
  edit.hidden = open || (kind === "keep" && isOwnNumberColumn(header));
  edit.addEventListener("click", () => {
    state.formatOpen.add(header);
    select.hidden = false;
    edit.hidden = true;
    select.focus();
  });
  const from = row.talked
    ? [el("span", { textContent: "訪問で聞いた値" }), el("span", { className: "value", textContent: row.talked.join("、") })]
    : row.from.length > 0
      ? row.from.flatMap((c) => [el("span", { textContent: kind === "plan" ? "入れた計画書" : kind === "keep" ? "計画書の番号" : c.header }), el("span", { className: "value", textContent: c.value })])
      : [el("span", { className: "plain", textContent: FLOW_PLAIN[kind] })];
  return el("div", { className: "flow-row" },
    el("div", { className: "flow-from" }, ...from),
    el("span", { className: "flow-arrow", textContent: "→" }),
    el("div", { className: "flow-to", textContent: header }),
    edit,
    ...(row.differs ? [el("div", { className: "flow-differs", textContent: `入れた計画書は「${row.differs}」です。次の画面で扱いを選びます。` })] : []),
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
  const { filled, conflicts, unread, helpers } = merge;
  $("mergeFilled").hidden = filled.length === 0;
  $("mergeFilled").textContent = `計画書から入った欄：${filled.map((f) => f.label).join("、")}`;
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
  if (conflicts.length === 0 && filled.length === 0) notes.push("計画書から新しく入った欄はありません。");
  if (helpers.length > 0) notes.push(`入れた計画書に手伝う人がいます（${helpers.join("、")}）。今も頼めるかを話の中で確かめ、印を付けてください。`);
  if ((state.imported.leftovers ?? []).length > 0) notes.push(`1列にまとめて書かれていた文は、欄に分けず手元に残しました：${state.imported.leftovers.map((l) => l.label).join("、")}`);
  if (unread.length > 0) notes.push(`形を読めなかったので入れていません：${unread.join("、")}`);
  $("mergeNotes").replaceChildren(...notes.map((n) => el("li", { textContent: n })));
}

async function confirmFormat() {
  showError($("formatError"), "");
  // 画面は元ごとにまとめて見せるので、並びは画面からとらず、様式の順番のまま渡す
  const columns = currentColumns();
  const unknown = columns.find((c) => c.target === "unknown");
  if (unknown) {
    showError($("formatError"), `「${unknown.header}」に入れる内容を選んでください。分からなければ「空のまま出す」を選べます。`);
    return;
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
  if (phone && (phone.length < 10 || phone.length > 11)) notes.push("本人の電話番号の桁数を確かめてください。");
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
$("connect").addEventListener("click", connect);
const backToStart = () => {
  columnsRequest += 1;
  $("send").disabled = false;
  $("sendState").hidden = true;
  goTo(1);
};
$("sendBack").addEventListener("click", backToStart);
$("confirmBack").addEventListener("click", () => goTo(2));
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
    document.querySelector(".top p").textContent = "今日できたことを確かめて、本人の1枚と渡すものを作ります。";
    $("step4").hidden = true;
    $("wrap").hidden = false;
    document.body.classList.add("wide-mode");
    window.scrollTo(0, 0);
  } else if (state.backToTalk) closeFormat();
  else goTo(state.table ? 3 : 1);
});
$("stepFormat").addEventListener("click", () => {
  reopenFormat();
  goTo(4);
});
$("changeFormat").addEventListener("click", openFormat);
$("wrapFormat").addEventListener("click", openFormat);
$("confirm").addEventListener("click", confirmMapping);
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
  // 公開デモでは実在のデータが入らないよう、架空のサンプルだけにする
  state.publicDemo = true;
  $("file").closest("label").hidden = true;
  $("planFile").closest("label").hidden = true;
  $("resume").closest("label").hidden = true;
  $("formatFile").closest("label").hidden = true;
  $("manualStart").hidden = true;
  document.querySelectorAll(".slot-drop").forEach((p) => { p.textContent = "公開版は架空の見本だけ使えます"; });
}).catch(() => {});
renderSlots();
goTo(1);
