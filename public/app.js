// 取り込みの画面。本物の値はこの画面の中だけで扱い、サーバーへは記号だけを送る
import { decodeCsv, parseCsv } from "/core/csv.js";
import { maskTable } from "/core/mask.js";
import { findLeaks } from "/core/redact.js";
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

function beginTalk(imported, options = {}) {
  state.imported = imported;
  for (const id of ["step1", "step2", "step3", "step4", "manual"]) $(id).hidden = true;
  document.querySelector(".steps").hidden = true;
  document.querySelector(".top h1").textContent = "訪問";
  document.querySelector(".top p").textContent = "話を聞いて、段取りと次の一歩を決めます。決めるのはご本人です。";
  startTalk(imported, options);
}

function goTo(step) {
  for (let i = 1; i <= 4; i++) {
    $(`step${i}`).hidden = i > step;
    const mark = document.querySelector(`.steps [data-step="${i}"]`);
    mark.classList.toggle("current", i === step);
    mark.classList.toggle("done", i < step);
  }
  $(`step${step}`).scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function loadBytes(bytes) {
  showError($("fileError"), "");
  const table = parseCsv(decodeCsv(bytes));
  if (table.headers.length === 0 || table.rows.length === 0) {
    showError($("fileError"), "見出しとデータのある CSV を選んでください。");
    return;
  }
  state.table = table;
  state.masked = maskTable(table);
  renderMask();
  goTo(2);
}

function renderMask() {
  const { payload, suspectHeaders } = state.masked;
  const leaks = findLeaks(payload, state.table.rows.flat());
  const blocked = suspectHeaders.length > 0 || leaks.length > 0;
  $("suspect").hidden = !blocked;
  $("suspect").textContent = blocked
    ? "見出しに、本物の値らしいものがあります。送らずに止めました。CSV の見出しを確かめてください。"
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

async function sendColumns() {
  showError($("sendError"), "");
  $("send").disabled = true;
  try {
    const res = await fetch("/api/read-columns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.masked.payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data.errors ?? ["読み取れませんでした"]).join(" / "));
    state.results = data.results;
    $("modeNotice").hidden = data.mode !== "mock";
    $("modeNotice").textContent = "今は Claude につないでいません。見出しの言葉から作った仮の答えです。";
    renderConfirm();
    goTo(3);
  } catch (e) {
    showError($("sendError"), `送れませんでした。${e.message}`);
  } finally {
    $("send").disabled = false;
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
    if (used.has(s.value)) {
      showError($("confirmError"), `「${s.dataset.header}」と「${used.get(s.value)}」が同じ欄になっています。`);
      return;
    }
    used.set(s.value, s.dataset.header);
    mapping[s.dataset.header] = s.value;
  }
  state.imported = importRow({ headers: state.table.headers, row: state.table.rows[Number($("who").value) || 0], mapping });
  renderResult(state.imported);
  goTo(4);
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
    wrap.replaceChildren(el("p", { className: "hint", textContent: "サービスの予定が CSV に無いので、話の中で聞きます。" }));
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
  beginTalk(importRow({ headers, row: headers.map((h) => String(form.get(h) ?? "")), mapping, source: "human" }));
});
$("resume").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    beginTalk(fromResumeFile(JSON.parse(await file.text())));
  } catch (err) {
    showError($("fileError"), `読み込めませんでした。${err.message}`);
  }
});
$("quickStart").addEventListener("click", async () => {
  const [bytes, mapping, script] = await Promise.all([
    fetch("/samples/keahakka_okano.csv").then((r) => r.arrayBuffer()),
    fetch("/samples/keahakka.mapping.json").then((r) => r.json()),
    fetch("/samples/okano.script.json").then((r) => r.json()),
  ]);
  const table = parseCsv(decodeCsv(new Uint8Array(bytes)));
  beginTalk(importRow({ headers: table.headers, row: table.rows[0], mapping }), { script });
});
fetch("/api/config").then((r) => r.json()).then(({ publicDemo }) => {
  if (!publicDemo) return;
  // 公開デモでは実在のデータが入らないよう、架空のサンプルだけにする
  $("file").closest("label").hidden = true;
  $("resume").closest("label").hidden = true;
  $("manualStart").hidden = true;
}).catch(() => {});
goTo(1);
