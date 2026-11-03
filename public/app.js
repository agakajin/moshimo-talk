// 取り込みの画面。本物の値はこの画面の中だけで扱い、サーバーへは記号だけを送る
import { decodeCsv, parseCsv } from "/core/csv.js";
import { maskTable } from "/core/mask.js";
import { findLeaks } from "/core/redact.js";
import { attachOutput, checkResumedFormat, DEFAULT_TARGETS, duplicateHeaders, OUTPUT_TARGETS, suspiciousHeaders } from "/core/format.js";
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
const TALK_TOPICS = [
  "大雨の夜の様子と、心配な災害",
  "逃げる先",
  "誰と、何で、何分で行くか",
  "ご近所で顔を知っている人",
  "避難の知らせの受け方",
  "持ち出すもの",
];
const WEEK = ["月", "火", "水", "木", "金", "土", "日"];

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};
const showError = (node, message) => { node.textContent = message; node.hidden = !message; };

const state = { table: null, masked: null, results: null };

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
  document.body.classList.add("wide-mode");
  document.querySelector(".top h1").textContent = "訪問";
  document.querySelector(".top p").textContent = "話を聞いて、段取りと次の一歩を決めます。決めるのはご本人です。";
  startTalk(imported, options);
}

function goTo(step) {
  for (let i = 1; i <= 5; i++) {
    $(`step${i}`).hidden = i > step;
    const mark = document.querySelector(`.steps [data-step="${i}"]`);
    mark.classList.toggle("current", i === step);
    mark.classList.toggle("done", i < step);
  }
  $(`step${step}`).scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function loadBytes(bytes) {
  // 訪問を始めたあとに遅れて届いた読み込みで、別の人の画面を開かない
  if (state.talkStarted) return;
  showError($("fileError"), "");
  // 待っている答えは、前のファイルのもの
  columnsRequest += 1;
  $("send").disabled = false;
  $("sendState").hidden = true;
  const refuse = (message) => {
    state.table = null;
    state.masked = null;
    goTo(1);
    showError($("fileError"), message);
  };
  const table = parseCsv(decodeCsv(bytes));
  if (table.unclosed) {
    refuse("引用符（\"）が閉じていない値があります。次の行まで1つの値に入ってしまうので、CSV を確かめてください。");
    return;
  }
  if (table.headers.length === 0 || table.rows.length === 0) {
    refuse("見出しとデータのある CSV を選んでください。");
    return;
  }
  const repeated = duplicateHeaders(table.headers);
  if (repeated.length > 0) {
    refuse(`同じ見出しが2つあります：${repeated.join("、")}。見出しを分けてから選んでください。`);
    return;
  }
  // 値のカンマで列がずれると、本物の値が別の欄に入る。取り込まずに知らせる
  const shifted = table.rows.findIndex((r) => r.slice(table.headers.length).some((v) => v.trim() !== ""));
  if (shifted >= 0) {
    refuse(`${shifted + 2}行目の列の数が、見出しより多くなっています。値の中のカンマを確かめてください。`);
    return;
  }
  state.table = table;
  state.masked = maskTable(table);
  renderMask();
  goTo(2);
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
  table.replaceChildren(el("tr", {}, el("th", { textContent: "列の見出し" }), el("th", { textContent: "送る値" })));
  for (const c of payload.columns) {
    const value = c.withheld
      ? el("td", { className: "withheld", textContent: "送りません" })
      : el("td", { className: "symbol", textContent: c.samples.join("、") });
    table.append(el("tr", {}, el("td", { textContent: c.header }), value));
  }
  $("payloadRaw").textContent = JSON.stringify(payload, null, 2);
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
  const table = $("confirmTable");
  table.replaceChildren(el("tr", {},
    el("th", { textContent: "列の見出し" }),
    el("th", { textContent: "計画の欄" }),
    el("th", { textContent: "手元の値（1件目）" })));
  state.results.forEach((r) => {
    const col = headers.indexOf(r.header);
    const select = el("select", { "ariaLabel": `${r.header} の欄` });
    select.dataset.header = r.header;
    for (const [value, label] of Object.entries(TARGETS)) select.append(el("option", { value, textContent: label }));
    select.value = r.target in TARGETS ? r.target : "unknown";
    const row = el("tr", { className: select.value === "unknown" ? "unknown" : "" },
      el("td", { textContent: r.header }),
      el("td", {}, select),
      el("td", { className: "local", textContent: rows[0]?.[col] ?? "" }));
    select.addEventListener("change", () => row.classList.toggle("unknown", select.value === "unknown"));
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
  state.imported = importRow({ headers: state.table.headers, row: state.table.rows[Number($("who").value) || 0], mapping });
  // 様式を選んだあとで選び直したときは、その様式のままにする
  chooseFormat(state.formatName ?? "ハッカ村", state.formatHeaders ?? null);
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
    $("formatTable").replaceChildren();
    showError($("formatError"), `様式を読めませんでした。${e.message}`);
  } finally {
    if (request === formatRequest) {
      choices.forEach((b) => { b.disabled = false; });
      $("formatState").hidden = true;
    }
  }
}

function renderFormat(columns) {
  const table = $("formatTable");
  $("formatChosen").textContent = `選んでいる様式：${state.formatName}`;
  $("formatChosen").hidden = false;
  table.replaceChildren(el("tr", {}, el("th", { textContent: `${state.formatName}の列` }), el("th", { textContent: "入れる内容" })));
  for (const { header, target } of columns) {
    const select = el("select", { ariaLabel: `${header} に入れる内容` });
    select.dataset.header = header;
    for (const [value, label] of Object.entries({ ...OUTPUT_TARGETS, unknown: "分からない（選んでください）" })) select.append(el("option", { value, textContent: label }));
    // 人が手で直した選択は、様式を読み直しても残す
    const edited = state.formatEdits?.[header];
    select.value = edited ?? (target in OUTPUT_TARGETS ? target : "unknown");
    const row = el("tr", { className: select.value === "unknown" ? "unknown" : "" }, el("td", { textContent: header }), el("td", {}, select));
    select.addEventListener("change", () => {
      row.classList.toggle("unknown", select.value === "unknown");
      state.formatEdits ??= {};
      state.formatEdits[header] = select.value;
    });
    table.append(row);
  }
}

async function confirmFormat() {
  showError($("formatError"), "");
  const selects = [...$("formatTable").querySelectorAll("select")];
  const unknown = selects.find((s) => s.value === "unknown");
  if (unknown) {
    showError($("formatError"), `「${unknown.dataset.header}」に入れる内容を選んでください。分からなければ「空のまま出す」を選べます。`);
    return;
  }
  const village = await loadVillage();
  attachOutput(state.imported, {
    base: village,
    name: state.formatName,
    columns: selects.map((s) => ({ header: s.dataset.header, target: s.value })),
  });
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

  const topics = [...TALK_TOPICS];
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

$("file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (file) loadBytes(new Uint8Array(await file.arrayBuffer()));
  e.target.value = "";
});
document.querySelectorAll("[data-sample]").forEach((b) => b.addEventListener("click", async () => {
  const res = await fetch(`/samples/${b.dataset.sample}`);
  loadBytes(new Uint8Array(await res.arrayBuffer()));
}));
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
  const { headers, unclosed } = parseCsv(decodeCsv(new Uint8Array(await file.arrayBuffer())));
  formatRequest += 1;
  $("formatDefault").disabled = false;
  $("formatMint").disabled = false;
  $("formatState").hidden = true;
  $("formatSend").hidden = true;
  $("formatGo").disabled = true;
  $("formatTable").replaceChildren();
  showError($("formatError"), "");
  if (unclosed) {
    showError($("formatError"), "引用符（\"）が閉じていない見出しや値があります。CSV を確かめてください。");
    return;
  }
  if (headers.length === 0) {
    showError($("formatError"), "見出しのある CSV を選んでください。");
    return;
  }
  const repeated = duplicateHeaders(headers);
  if (repeated.length > 0) {
    showError($("formatError"), `同じ見出しが2つあります：${repeated.join("、")}。「本人の氏名」「支援者の氏名」のように分けてから選んでください。`);
    return;
  }
  const suspicious = suspiciousHeaders(headers, state.imported ?? {});
  if (suspicious.length > 0) {
    showError($("formatError"), `見出しに改行や、名前、番号らしいものがあるので、送らずに止めました：${suspicious.join("、")}`);
    return;
  }
  // 取り込みと同じく、送る前に中身を見せる
  $("formatSendList").textContent = headers.join("、");
  $("formatSendGo").onclick = () => chooseFormat(file.name.replace(/\.csv$/i, ""), headers);
  $("formatSend").hidden = false;
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
// 確定したあとで選び直したら、確定をやり直す。別の人の計画で始めないため
for (const id of ["who", "confirmTable"]) $(id).addEventListener("change", () => { if (!$("step4").hidden) goTo(3); });
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
fetch("/api/config").then((r) => r.json()).then(({ publicDemo }) => {
  if (!publicDemo) return;
  // 公開デモでは実在のデータが入らないよう、架空のサンプルだけにする
  $("file").closest("label").hidden = true;
  $("resume").closest("label").hidden = true;
  $("formatFile").closest("label").hidden = true;
  $("manualStart").hidden = true;
}).catch(() => {});
goTo(1);
