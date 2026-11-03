// 訪問の画面。声メモは送る前に伏せ、送る中身をそのまま見せる
import { applyUpdates, editField, fieldsBefore, moveField, placedFields, planForClaude, serviceGaps, setIdentity } from "/core/plan.js";
import { blankColumns, planFieldList, requiredBlanks } from "/core/format.js";
import { parseMinutes } from "/core/normalize.js";
import { findLeaks, redact, redactDeep } from "/core/redact.js";
import { nextTopic, REQUEST_NOTE } from "/core/talk.js";
import { chooseKey, createPushToTalk, DEFAULT_KEY, keyCode, keyLabel, keyTriggers } from "/core/voice.js";
import { createLatest, createQueue } from "/core/work.js";
import { startWrap } from "/wrap.js";

const SOURCE = { csv: "CSV から", voice: "声メモから", human: "人が入れた" };
const WEEK = ["月", "火", "水", "木", "金", "土", "日"];

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};
const getAt = (obj, path) => path.split(".").reduce((o, k) => o[k], obj);

const WAIT_LIMIT = 90_000; // 電波の弱い家でも待ち続けない
const WRAP_WAIT = 20_000;
const MAX_MEMO = 1000;
// CSV の値でも、場所や介護の言葉は話に出てよい
const COMMON_PART = /公民館|集会所|小学校|中学校|体育館|避難所|公園|神社|センター|会館|広場|高台|トイレ|デイサービス|車いす|車椅子|歩行器|補聴器|自動車|トラック|タクシー|ヘルパー|娘|息子|嫁|孫|あり|なし/;

async function post(url, body) {
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(WAIT_LIMIT) });
  } catch (e) {
    throw new Error(e.name === "TimeoutError" ? "時間がかかりすぎました。電波を確かめてください" : "つながりませんでした。電波を確かめてください");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.errors ?? ["送れませんでした"]).join(" / "));
  return data;
}

export function startTalk(state, { script = null } = {}) {
  const { identity, plan } = state;
  state.people ??= [];
  let FIELDS = planFieldList(state);
  let LABEL = new Map(FIELDS.map((f) => [f.path, f.label]));
  // Claude に渡す、様式から足した欄の一覧
  const extraFields = () => FIELDS.filter((f) => f.path.startsWith("extra.")).map((f) => ({ key: f.path, label: f.label }));
  const gaps = serviceGaps(plan);
  let scriptIndex = 0;
  const skipped = [];
  const skippedFields = new Set();
  const shownInterrupts = new Set();
  let findings = [];
  let checkError = "";
  let interrupt = null;
  let memoCount = 0;
  let pendingMemos = 0;
  let checking = false;
  // 声メモが入れた欄と入る前の中身。この訪問の間はいつでも移せる。計画には残さない
  const fresh = new Map();
  // 色を付けるのは、最後に入った欄だけ
  let latest = new Set();
  let freshHelpers = new Set();
  let moving = null;
  // 欄に入らなかった声メモを、選んだ欄へ入れている間
  let placing = null;
  let dragged = null;
  const planRows = new Map();
  let goalPaths = new Set();
  const helperRows = new Map();
  const changeBoxes = new Map();
  // 様式を変えて欄を作り直すとき、開いている箱を出し直すための控え
  const changeRetry = new Map();
  const changeQueue = new Map();
  const placedNotes = new Map();
  const scribeQueue = createQueue();
  const checker = createLatest(runCheck);
  const refreshFindings = () => (pendingMemos > 0 ? Promise.resolve() : checker.request());

  const known = [
    { value: identity["self.name"], alias: "本人" },
    { value: identity["self.kana"], alias: "本人" },
    { value: identity["self.address"], alias: "自宅", kind: "address" },
    { value: identity["self.birth"], alias: "[日付]", kind: "birth" },
    { value: identity["emergency.name"], alias: "緊急連絡先" },
    { value: identity["self.phone"], alias: "[電話番号]", kind: "phone" },
    { value: identity["emergency.phone"], alias: "[電話番号]", kind: "phone" },
  ];
  // 性別は「女」など一般の言葉なので、漏れの検査の対象にしない
  const secrets = Object.entries(identity).filter(([k]) => k !== "self.gender").filter(([, v]) => v).map(([k, value]) => (k === "self.address" ? { value, kind: "address" } : value));
  for (const p of state.people) {
    known.unshift({ value: p.name, alias: p.alias });
    secrets.push(p.name);
    if (p.phone) {
      known.push({ value: p.phone, alias: "[電話番号]", kind: "phone" });
      secrets.push(p.phone);
    }
  }

  // CSV の「計画に無い欄」の値も、手元にある値として声メモから伏せる。「佐藤内科(佐藤一郎)」は分けて探す
  // 短い部分はふつうの言葉と重なるので除く。中身が分からない値なので、一致しても送信は止めない
  for (const f of Object.values(plan.extra ?? {})) {
    if (f.source !== "csv" || typeof f.value !== "string") continue;
    const parts = f.value.split(/[\s　()（）、,，/／・:：]+/);
    for (const part of new Set([f.value.trim(), f.value.replace(/\s/g, ""), ...parts])) {
      if (part.length >= 3 && !COMMON_PART.test(part)) known.unshift({ value: part, alias: "[手元の値]", kind: "whole" });
    }
  }

  // 手元の情報を直す。名前や番号が増えたら、声メモからも伏せる
  const localErrors = new Set();
  const LOCAL_FIELDS = [["self.name", "氏名", { alias: "本人" }], ["self.kana", "ふりがな", { alias: "本人" }], ["self.birth", "生年月日", { alias: "[日付]", kind: "birth" }], ["self.gender", "性別", null], ["self.postal", "郵便番号", { alias: "[郵便番号]" }], ["self.address", "住所", { alias: "自宅", kind: "address" }], ["self.phone", "本人の電話", { alias: "[電話番号]", kind: "phone" }], ["emergency.name", "緊急連絡先の氏名", { alias: "緊急連絡先" }], ["emergency.phone", "緊急連絡先の電話", { alias: "[電話番号]", kind: "phone" }]];
  $("localFields").replaceChildren(...LOCAL_FIELDS.map(([key, label, guard]) => {
    const input = el("input", { className: "plan-input", value: identity[key] ?? "", ariaLabel: label, autocomplete: "off" });
    input.addEventListener("change", () => {
      const typed = input.value.trim();
      const value = setIdentity(identity, key, typed);
      // 読めない値では元の値を消さない。直すまで案内を残す
      if (value === null) localErrors.add(label);
      else localErrors.delete(label);
      $("localError").hidden = localErrors.size === 0;
      $("localError").textContent = `読み取れませんでした。形を確かめてください（元の値のままです）：${[...localErrors].join("、")}`;
      input.value = value ?? typed;
      if (value && guard) {
        known.unshift({ value, ...guard });
        secrets.push(guard.kind === "address" ? { value, kind: "address" } : value);
      }
      renderAll();
    });
    return el("label", { className: "field-label" }, label, input);
  }));

  $("talk").hidden = false;
  renderAll();
  renderPeople();
  refreshFindings();

  function renderOpener() {
    const box = $("opener").closest(".opener");
    box.classList.toggle("interrupt", Boolean(interrupt));
    const topic = currentTopic();
    $("openerLabel").textContent = interrupt ? `気になること（${interrupt.yardstick}）` : "話のきっかけ";
    $("opener").textContent = interrupt?.opener ?? topic?.text ?? "ひと通り話せました。";
    $("skip").hidden = !topic && !interrupt;
    renderGoal(interrupt ? null : topic);
  }

  // 最初の1問は暮らしの話から入る。分かっている寝室を言うので、二度聞かないことも伝わる
  // 2問目からは必須の欄につながる話を先に聞く。用意した話が尽きたら、残りの必須の欄を直接聞く。必須でない話はそのあと
  function currentTopic() {
    if (memoCount === 0) {
      const first = nextTopic(plan, { gaps, skipped });
      if (first?.id === "hazards") return first;
    }
    const required = requiredBlanks(state);
    const later = [];
    for (;;) {
      const topic = nextTopic(plan, { gaps, skipped: [...skipped, ...later] });
      if (!topic) break;
      if (topic.fills.some((p) => required.fields.has(p) || (p === "helpers" && required.helper))) return topic;
      later.push(topic.id);
    }
    // 飛ばした話の欄は、言い方を変えて聞き直さない
    const blank = [...required.fields.keys()].find((p) => !skippedFields.has(p));
    if (blank) return { id: `blank:${blank}`, text: `${LABEL.get(blank) ?? blank}について、伺えますか？`, fills: [blank] };
    return nextTopic(plan, { gaps, skipped });
  }

  // この話で埋めたい欄を見せる
  function renderGoal(topic) {
    goalPaths = new Set(topic?.fills ?? []);
    const chips = [...goalPaths].map((path) => {
      const name = path === "helpers" ? "近くの人" : LABEL.get(path);
      if (!name) return null;
      const button = el("button", { className: "chip", type: "button", textContent: name });
      button.addEventListener("click", () => {
        const target = planRows.get(path);
        (target?.row ?? $("planHelpers")).scrollIntoView({ block: "center" });
        target?.input.focus();
      });
      return button;
    }).filter(Boolean);
    $("openerGoal").replaceChildren(...(chips.length ? [el("span", { textContent: "この話で埋める欄：" }), ...chips] : interrupt ? [el("span", { textContent: "計画の穴を確かめる問いかけです" })] : []));
    markGoal();
  }

  function markGoal() {
    for (const [path, { row }] of planRows) row.classList.toggle("goal-row", goalPaths.has(path));
  }

  function renderWeek() {
    const items = plan.care.weekly.value?.items ?? [];
    if (items.length === 0) {
      $("talkWeek").replaceChildren(el("p", { className: "hint", textContent: "サービスの予定が分からないので、話の中で聞きます。" }));
      return;
    }
    const days = WEEK.map((d) => {
      const here = items.filter((i) => i.days.includes(d));
      const isGap = gaps?.includes(d);
      // 話に出た曜日は、聞けたと分かるようにする
      const heard = isGap && [plan.home.aloneHours.value, plan.timeBands.value].some((v) => new RegExp(`(?<!\\p{Script=Han})${d}(?:曜|[・、,と]|の昼|は)|[・、,と]${d}`, "u").test(String(v ?? "")));
      const text = here.length ? here.map((i) => `${i.kind} ${i.start}〜${i.end}`).join(" ") : heard ? "話に出ました" : isGap ? "昼はどなたが？" : "サービスなし";
      return el("div", { className: `day ${here.length ? "covered" : isGap && !heard ? "gap" : ""}` }, el("b", { textContent: d }), text);
    });
    $("talkWeek").replaceChildren(el("div", { className: "week-wrap" }, el("div", { className: "week" }, ...days)));
  }

  function finishMove(from, to, result) {
    fresh.delete(from);
    latest.delete(from);
    fresh.set(to, result.replaced);
    latest.add(to);
    // 声メモの一覧の案内も、移した先に合わせる
    const note = placedNotes.get(from);
    if (note) {
      note.textContent = note.textContent.replace(LABEL.get(from), `${LABEL.get(to)}（移しました）`);
      placedNotes.delete(from);
      placedNotes.set(to, note);
    }
    renderAll();
    refreshFindings();
  }

  function movePlaced(to) {
    const from = moving;
    const value = getAt(plan, from).value;
    const previous = fresh.get(from) ?? null;
    const result = moveField(plan, from, to, { previous });
    if (result.reason === "minutes") {
      $("moveText").textContent = `「${value}」は時間として読めないので、${LABEL.get(to)}には移せません。別の欄を選んでください。`;
      return;
    }
    if (result.reason === "occupied") {
      moving = null;
      renderAll();
      askChange(to, result.current, value, (edited) => {
        if (getAt(plan, from).value !== value) return "移す元の欄が変わったので、移せません。今のままにしてください。";
        const done = moveField(plan, from, to, { previous, overwrite: true, value: edited });
        if (done.reason === "minutes") return `「${edited}」は時間として読めません。数字で入れてください。`;
        finishMove(from, to, done);
        return null;
      }, { focus: true });
      return;
    }
    if (!result.moved) return;
    moving = null;
    finishMove(from, to, result);
    planRows.get(to).input.focus();
  }

  // 箱の中に、あと何件の案が待っているかを出す
  function showWaiting(path) {
    const why = changeBoxes.get(path)?.querySelector(".why");
    const waiting = changeQueue.get(path) ?? [];
    if (!why) return;
    why.hidden = waiting.length === 0;
    why.textContent = waiting.length === 0 ? "" : `別の案があと${waiting.length}件あります（${waiting.map((w) => `「${w.proposed}」`).join("、")}）。この箱を閉じると出ます。`;
  }

  // 箱を閉じて、待っている次の案を出す。今の内容と同じ案は聞かない
  function closeChange(path) {
    changeBoxes.get(path)?.remove();
    changeBoxes.delete(path);
    renderPlan();
    const waiting = changeQueue.get(path) ?? [];
    let next = waiting.shift();
    while (next && next.proposed === getAt(plan, path).value) next = waiting.shift();
    if (!next) return;
    askChange(path, getAt(plan, path).value, next.proposed, next.apply, { owner: next.owner });
    showWaiting(path);
  }

  // 値のある欄を変えるときは、その欄のすぐ下で確かめる。提案はその場で直せる。1つの欄に箱は1つ
  function askChange(path, current, proposed, apply, { focus = false, owner = null, edited = false } = {}) {
    const open = changeBoxes.get(path);
    // 開いている箱は消さない。次の案は、この箱を閉じたあとに出す
    if (open) {
      if (!changeQueue.has(path)) changeQueue.set(path, []);
      const same = open.querySelector("input").value === proposed || changeQueue.get(path).some((w) => w.proposed === proposed);
      if (!same) changeQueue.get(path).push({ proposed, apply, owner });
      showWaiting(path);
      return;
    }
    const label = LABEL.get(path) ?? path;
    let shown = current;
    const nowText = () => `${label}：今は「${shown ?? "未決定"}」`;
    const now = el("p", { textContent: nowText() });
    const input = el("input", { className: "plan-input", value: proposed, ariaLabel: `${label}の変更後` });
    const why = el("p", { className: "why", hidden: true });
    const yes = el("button", { className: "button primary", type: "button", textContent: "この内容に変える" });
    const no = el("button", { className: "button", type: "button", textContent: "今のままにする" });
    // 置き換えると前の話が消えるので、足す形も選べるようにする
    const add = el("button", { className: "button", type: "button", textContent: "今の内容に足す" });
    // 案に今の内容がもう入っているときは、足すと文が重なるので出さない
    add.hidden = !shown || path.endsWith("Minutes") || proposed.includes(shown);
    // 足したあとは、同じボタンで足す前に戻せる
    let beforeAdd = null;
    add.addEventListener("click", () => {
      if (beforeAdd !== null) {
        input.value = beforeAdd;
        beforeAdd = null;
        add.textContent = "今の内容に足す";
      } else {
        const current = getAt(plan, path).value;
        if (!current) return;
        beforeAdd = input.value;
        input.value = `${current}、${input.value}`;
        add.textContent = "足す前に戻す";
      }
      box.edited = true;
      input.focus();
    });
    // 足したあとに手で直したら、戻すと直した文字が消えるので、ボタンを下げる
    input.addEventListener("input", () => {
      if (beforeAdd === null) return;
      beforeAdd = null;
      add.textContent = "今の内容に足す";
      add.hidden = true;
    });
    const box = el("div", { className: "notice change-box" }, now, el("label", { className: "field-label" }, "変更後（直せます）", input), el("div", { className: "row" }, yes, add, no), why);
    const say = (message) => {
      why.textContent = message;
      why.hidden = false;
    };
    const close = () => {
      closeChange(path);
      planRows.get(path).input.focus();
    };
    input.addEventListener("input", () => { box.edited = true; });
    no.addEventListener("click", close);
    yes.addEventListener("click", () => {
      const value = input.value.trim();
      if (!value) {
        say("変更後が空です。今のままにするか、内容を入れてください。");
        return;
      }
      // 尋ねている間に欄が変わっていたら、古い話のまま変えない
      const latestValue = getAt(plan, path).value;
      if (latestValue !== shown) {
        shown = latestValue;
        now.textContent = nowText();
        say("欄の内容が変わりました。確かめて、もう一度押してください。");
        return;
      }
      const problem = apply(value);
      if (problem) say(problem);
      else close();
    });
    planRows.get(path).row.after(box);
    changeBoxes.set(path, box);
    box.owner = owner;
    box.edited = edited;
    changeRetry.set(path, () => ({ path, proposed: input.value, apply, owner, edited: box.edited }));
    renderPlan();
    if (focus) {
      input.focus();
      box.scrollIntoView({ block: "nearest" });
    }
  }

  // 欄もボタンも作り直さず中身だけ変える。作り直すと、Tab で移った先や、押している途中のボタンが消える
  function buildPlanRows() {
    for (const { path, label, mark } of FIELDS) {
      const input = el("input", { className: "plan-input", placeholder: "未決定", ariaLabel: label });
      input.dataset.path = path;
      input.addEventListener("change", () => {
        editField(plan, path, input.value);
        fresh.delete(path);
        latest.delete(path);
        renderAll();
        refreshFindings();
      });
      // 打っている間に届いた答えは、欄を離れたときに見せる
      input.addEventListener("blur", () => { input.value = getAt(plan, path).value ?? ""; });
      const note = el("span");
      const badge = el("span", { className: "badge", hidden: true });
      const move = el("button", { className: "button mini", type: "button", textContent: "移す", ariaLabel: `${label}の内容を別の欄へ移す` });
      move.addEventListener("click", () => {
        moving = path;
        renderAll();
        $("moveCancel").focus();
      });
      const here = el("button", { className: "button mini", type: "button", textContent: "ここへ", ariaLabel: `${label}へ移す` });
      const row = el("div", {}, el("span", { className: "name" }, label, badge, el("small", { className: "mark", textContent: mark })), input, el("span", { className: "source" }, note, move, here));
      // 移している間は、行のどこを押しても行き先になる
      row.addEventListener("click", () => {
        if (placing) {
          const memo = placing;
          placing = null;
          renderAll();
          placeMemo(path, memo);
        } else if (moving && moving !== path) movePlaced(path);
      });
      row.addEventListener("dragover", (e) => {
        if (!dragged) return;
        e.preventDefault();
        row.classList.add("drop");
      });
      row.addEventListener("dragleave", () => row.classList.remove("drop"));
      row.addEventListener("drop", (e) => {
        if (!dragged) return;
        e.preventDefault();
        row.classList.remove("drop");
        placeMemo(path, dragged);
      });
      planRows.set(path, { row, input, note, move, here, badge });
      $("planFields").append(row);
    }
  }

  function helperRow(h) {
    if (helperRows.has(h)) return helperRows.get(h);
    const asked = el("input", { type: "checkbox" });
    asked.addEventListener("change", () => {
      h.asked = asked.checked;
      h.askedBy = "human";
      renderPlan();
      refreshFindings();
    });
    const remove = el("button", { className: "button mini", type: "button", textContent: "取り消す", ariaLabel: `${h.alias}を計画から外す` });
    remove.addEventListener("click", () => {
      plan.helpers = plan.helpers.filter((x) => x !== h);
      // 同じ呼び名で別の人を入れ直したとき、前の人の名前を出さない。置き換えのための控えは残す
      state.people = state.people.filter((p) => p.alias !== h.alias);
      freshHelpers.delete(h.alias);
      renderPeople();
      renderPlan();
      refreshFindings();
    });
    const who = el("span");
    const note = el("span");
    const row = el("div", {}, el("span", { className: "name", textContent: "近くの人" }),
      el("span", { className: "who" }, who, el("label", {}, asked, "頼めた")),
      el("span", { className: "source" }, note, remove));
    const parts = { row, asked, who, note };
    helperRows.set(h, parts);
    return parts;
  }

  // 残りを一覧で見せる。押すとその欄へ移る
  function renderStatus({ fields, local, helper }) {
    const goTo = (target) => {
      if (target.row?.tagName === "DETAILS") target.row.open = true;
      target.row?.scrollIntoView({ block: "center" });
      target.focus?.focus();
    };
    const chip = (text, className, target) => {
      const button = el("button", { className: `chip ${className}`, type: "button", textContent: text });
      button.addEventListener("click", () => goTo(target));
      return button;
    };
    const confirms = [...changeBoxes].map(([path, box]) => chip(`確認：${LABEL.get(path) ?? path}`, "confirm", { row: planRows.get(path).row, focus: box.querySelector("input") }));
    const blanks = [...fields.keys()].map((path) => chip(LABEL.get(path) ?? path, "", { row: planRows.get(path).row, focus: planRows.get(path).input }));
    if (helper) blanks.push(chip(`${helper}（頼めた人）`, "", { row: $("planHelpers"), focus: null }));
    const looseMemos = [...$("memos").querySelectorAll(".loose")];
    const memoChip = looseMemos.length ? [chip(`入らなかった声メモ ${looseMemos.length}件`, "confirm", { row: looseMemos[0], focus: null })] : [];
    const mustCount = blanks.length;
    const count = mustCount + confirms.length === 0
      ? el("p", { className: "count done", textContent: "必須の欄はすべて入りました。確認もありません" })
      : el("p", { className: "count", textContent: `残り：必須 ${mustCount}件／確認 ${confirms.length}件` });
    // 頼めた人の名前の入れ場所は、手元の情報ではなく「話に出た人の名前」
    const notes = local.map((name) => (state.output?.targets?.[name]?.startsWith("helper")
      ? chip(`${name}（名前を入れる）`, "plain", { row: $("personName").closest("details"), focus: $("personName") })
      : chip(`${name}（手元の情報）`, "plain", { row: $("localInfo"), focus: null })));
    $("planStatus").hidden = Boolean(moving || placing);
    $("planStatus").replaceChildren(count, el("div", { className: "chips" }, ...memoChip, ...confirms, ...blanks, ...notes));
  }

  function renderPeople() {
    // 名前は画面の中だけ。呼び名で一覧に出す
    $("people").replaceChildren(...state.people.map((p) => el("li", { textContent: `${p.alias}：入力ずみ` })));
  }

  function renderPlan() {
    if (planRows.size === 0) buildPlanRows();
    const required = requiredBlanks(state);
    for (const [path, { row, input, note, move, here, badge }] of planRows) {
      const f = getAt(plan, path);
      const isLatest = latest.has(path);
      const isRequired = required.fields.has(path);
      const confirming = changeBoxes.has(path);
      const choosing = moving || placing;
      row.className = `plan-row ${f.status}${isRequired ? " required" : ""}${confirming ? " confirming" : ""}${isLatest ? " fresh" : ""}${moving === path ? " moving" : ""}${choosing && moving !== path ? " target" : ""}`;
      badge.hidden = !isRequired && !confirming;
      badge.textContent = confirming ? "確認" : "必須";
      badge.className = confirming ? "badge confirm" : "badge";
      input.placeholder = isRequired ? "未記入" : "未決定";
      // 打っている欄の文字は消さない。移している間は打っていないので、行き先にも値を見せる
      if (document.activeElement !== input || input.readOnly) input.value = f.value ?? "";
      input.readOnly = Boolean(choosing);
      note.textContent = moving === path ? "これを移します" : choosing ? "" : isLatest ? (f.source === "human" ? "移しました" : "いま入った") : SOURCE[f.source] ?? "";
      move.hidden = Boolean(choosing) || !fresh.has(path) || f.status !== "filled";
      here.hidden = !choosing || moving === path;
    }
    renderStatus(required);
    $("moveBar").hidden = !moving && !placing;
    if (moving) $("moveText").textContent = `「${getAt(plan, moving).value}」を、どの欄に移しますか？`;
    if (placing) $("moveText").textContent = `「${placing.memo}」を、どの欄に入れますか？`;
    markGoal();
    const rows = plan.helpers.map((h) => {
      const parts = helperRow(h);
      const isFresh = freshHelpers.has(h.alias);
      parts.row.className = `plan-row plan-helper filled${isFresh ? " fresh" : ""}`;
      parts.who.textContent = `${h.alias}${h.awayWeekdayDaytime ? "（平日の昼は不在）" : ""}`;
      parts.asked.checked = h.asked === true;
      parts.note.textContent = isFresh ? "いま入った" : "";
      return parts.row;
    });
    // 同じ顔ぶれなら置き直さない。押したチェックからフォーカスが外れないように
    const box = $("planHelpers");
    if (rows.length !== box.children.length || rows.some((r, i) => box.children[i] !== r)) box.replaceChildren(...rows);
  }

  function renderRequests() {
    // 点検の文が変わっても、選んだものは一覧に残して外せるようにする
    const options = [...new Set([...plan.requests, ...findings.filter((f) => f.request).map((f) => f.request)])].map((request) => ({ request }));
    if (options.length === 0) {
      $("requests").replaceChildren(el("p", { className: "hint", textContent: "話が進むと、ここに案が出ます。" }));
    } else {
      $("requests").replaceChildren(...options.map((f) => {
        const chosen = plan.requests.includes(f.request);
        const box = el("input", { type: "checkbox", checked: chosen });
        const label = el("label", { className: `request ${chosen ? "chosen" : ""}` }, box,
          el("span", {}, f.request, el("small", { textContent: REQUEST_NOTE })));
        box.addEventListener("change", () => {
          plan.requests = box.checked ? [...plan.requests, f.request] : plan.requests.filter((r) => r !== f.request);
          if (!box.checked) plan.requestsDone = plan.requestsDone.filter((r) => r !== f.request);
          renderRequests();
        });
        return label;
      }));
    }
    $("findings").replaceChildren(...(checkError
      ? [el("li", { className: "notice", textContent: checkError })]
      : findings.length
      ? findings.map((f) => el("li", { textContent: `${f.text}（${f.yardstick}）` }))
      : [el("li", { className: "hint", textContent: checking ? "点検しています。" : "今のところありません。" })]));
  }

  function renderAll() {
    // 呼び名は計画にいる人から選べるようにする。打ち間違えると、同じ人が2行に分かれて名前が CSV に届かない
    $("aliasList").replaceChildren(...plan.helpers.map((h) => el("option", { value: h.alias })));
    renderOpener();
    renderWeek();
    renderPlan();
    renderRequests();
  }

  function showSent(label, body) {
    $("sentRaw").textContent = `${label}\n${JSON.stringify(body, null, 2)}`;
  }

  // 手で直した欄も、送る形にするときは置き換える
  function planToSend() {
    return redactDeep(planForClaude(plan), known);
  }

  function guarded(body) {
    const leaks = findLeaks(body, secrets);
    if (leaks.length > 0) throw new Error("本物の名前や番号が残っていたので、送らずに止めました。文字を直してください。");
    return body;
  }

  function markMode(mode) {
    $("talkMode").hidden = mode !== "mock";
    $("talkMode").textContent = "今は Claude につないでいません。書き取りと点検は、台本の言葉にだけ反応する仮の答えです。";
  }

  function renderWork() {
    const parts = [];
    if (pendingMemos > 0) parts.push(`声メモを書き取っています（あと${pendingMemos}件）`);
    if (checking) parts.push("裏で点検しています");
    $("workState").hidden = parts.length === 0;
    $("workState").textContent = parts.length ? `${parts.join("／")}。話を続けて大丈夫です。` : "";
  }

  async function runCheck(isStale) {
    // 書き取りが残っているときの答えは、すぐ古くなるので使わない
    const outdated = () => isStale() || pendingMemos > 0;
    checking = true;
    state.checking = true;
    renderWork();
    state.refreshWrap?.();
    renderRequests();
    try {
      const body = guarded({ plan: planToSend(), gaps, blanks: blankColumns(state.output, plan), fields: extraFields() });
      showSent("点検役へ", body);
      const data = await post("/api/check", body);
      if (outdated()) return;
      markMode(data.mode);
      findings = data.findings;
      checkError = "";
      // 話を始める前に割り込まない。最初の一言は話のきっかけから入る
      // 出ている問いかけは、関係ない操作で消さない
      const still = interrupt && findings.find((f) => f.id === interrupt.id);
      interrupt = still ?? (memoCount > 0 ? findings.find((f) => f.interrupt && !shownInterrupts.has(f.id)) ?? null : null);
      if (interrupt) shownInterrupts.add(interrupt.id);
    } catch (e) {
      if (outdated()) return;
      // 「ありません」と見えないよう、点検できなかったことを出す
      checkError = `点検できませんでした。${e.message}`;
    } finally {
      checking = false;
      state.checking = false;
      renderWork();
      // 訪問終了の画面を開いたあとに届いた点検も、次の一歩に入れる
      state.checkFailed = Boolean(checkError);
      state.refreshWrap?.();
    }
    renderOpener();
    renderRequests();
  }

  let micTalk = null;

  function addMemo() {
    // 文字を待っている間に送ると、途中の文が届き、残りがもう一度送られる
    if (micTalk?.busy()) return;
    $("memoError").hidden = true;
    const raw = $("memo").value;
    if (!raw.trim()) return;
    let memo;
    try {
      if (raw.length > MAX_MEMO) throw new Error(`声メモが長すぎます（${raw.length}字）。${MAX_MEMO}字までに分けて入れてください。`);
      memo = redact(raw, known);
      guarded({ memo });
    } catch (e) {
      $("memoError").textContent = e.message;
      $("memoError").hidden = false;
      return;
    }
    $("memo").value = "";
    const item = el("li", { className: "pending", textContent: memo });
    $("memos").append(item);
    sendMemo(memo, item);
  }

  function sendMemo(memo, item, { late = false } = {}) {
    pendingMemos += 1;
    renderWork();
    scribeQueue.add(async () => {
      try {
        const body = guarded({ memo, plan: planToSend(), fields: extraFields() });
        showSent("書き取り役へ", body);
        const data = await post("/api/scribe", body);
        markMode(data.mode);
        memoCount += 1;
        $("memoError").hidden = true;
        const before = fieldsBefore(plan, data.updates);
        const conflicts = applyUpdates(plan, data.updates, memoCount, { late });
        // 答えを待つ間に様式を変えると、行のない欄へ入ることがある。隠さず行を作る
        if (data.updates.some((u) => u.path.startsWith("extra.") && !LABEL.has(u.path))) state.refreshFormat();
        askConflicts(conflicts);
        // 移している途中でも、話は続くので操作は止めない。前の欄もあとから移せるよう足していく
        const placedNow = placedFields(plan, before, memoCount);
        for (const [path, previous] of placedNow) fresh.set(path, previous);
        const helpersNow = data.updates.filter((u) => u.path === "helpers.add");
        if (placedNow.size > 0 || helpersNow.length > 0) {
          latest = new Set(placedNow.keys());
          freshHelpers = new Set(helpersNow.map((u) => u.value.alias));
        }
        item.className = "";
        const placed = [...placedNow.keys()].map((p) => LABEL.get(p) ?? p);
        const names = [...placed, ...helpersNow.map((u) => `近くの人（${u.value.alias}）`)];
        for (const { value } of helpersNow) {
          if (value.declined && plan.helpers.some((h) => h.alias === value.alias && h.asked)) item.append(el("small", { className: "placed", textContent: `→ ${value.alias}は断られたようです。「頼めた」の印を確かめてください` }));
        }
        if (names.length > 0) {
          const note = el("small", { className: "placed", textContent: `→ ${names.join("、")}に入りました` });
          item.append(note);
          for (const path of placedNow.keys()) placedNotes.set(path, note);
        }
        if (conflicts.length > 0) item.append(el("small", { className: "placed", textContent: `→ ${conflicts.map((c) => LABEL.get(c.path) ?? c.path).join("、")}：今の内容と違うので、確認が出ています` }));
        if (data.updates.length === 0) makeLoose(item, memo);
        if (data.dropped > 0) item.append(el("small", { className: "hint", textContent: ` 一部は根拠を確かめられず、計画に入れていません。欄を確かめてください。` }));
        interrupt = null;
      } catch (e) {
        // 話した内容を失わないよう、一覧に残してやり直せるようにする
        item.className = "failed";
        const retry = el("button", { className: "button", textContent: "もう一度入れる" });
        retry.addEventListener("click", () => {
          retry.remove();
          item.className = "pending";
          sendMemo(memo, item, { late: true });
        });
        item.append(" ", retry);
        $("memoError").textContent = `計画に入りませんでした。${e.message}`;
        $("memoError").hidden = false;
      } finally {
        pendingMemos -= 1;
        renderWork();
        renderAll();
        refreshFindings();
        state.refreshWrap?.();
      }
    });
  }

  // 欄に入らなかった声メモ。ドラッグか「欄へ入れる」で、人が入れる先を決める
  function makeLoose(item, memo) {
    const note = el("small", { className: "placed", textContent: "→ 欄には入りませんでした。欄へドラッグできます " });
    const button = el("button", { className: "button mini", type: "button", textContent: "欄へ入れる" });
    const loose = { item, memo, note, button };
    note.append(button);
    item.append(note);
    item.classList.add("loose");
    item.scrollIntoView({ block: "nearest" });
    item.draggable = true;
    button.addEventListener("click", () => {
      moving = null;
      placing = loose;
      renderAll();
      $("moveCancel").focus();
    });
    item.addEventListener("dragstart", (e) => {
      if (!item.draggable) return;
      dragged = loose;
      e.dataTransfer.setData("application/x-hinan-memo", "memo");
      e.dataTransfer.effectAllowed = "move";
      $("planFields").classList.add("dropping");
    });
    item.addEventListener("dragend", () => {
      dragged = null;
      $("planFields").classList.remove("dropping");
    });
  }

  function placeMemo(path, loose) {
    const { item, memo, note, button } = loose;
    if (loose.placed) return;
    if (placing === loose) {
      placing = null;
      renderAll();
    }
    // 1つの声メモの確認は1つだけ。入れ直したら、前の案を取り下げる。ほかの話の箱には触らない
    const own = [...changeBoxes.values()].find((box) => box.owner === loose);
    // 箱で直していた文字は、次の欄へ引き継ぐ
    const typed = own?.edited ? own.querySelector("input").value : null;
    for (const [p, waiting] of changeQueue) {
      changeQueue.set(p, waiting.filter((w) => w.owner !== loose));
      showWaiting(p);
    }
    for (const [p, box] of [...changeBoxes]) if (box.owner === loose) closeChange(p);
    const label = LABEL.get(path) ?? path;
    const f = getAt(plan, path);
    const put = (value) => {
      if (loose.placed) return "この声メモは、もう別の欄へ入れました。今のままにしてください。";
      if (path.endsWith("Minutes") && parseMinutes(value) === null) return `「${value}」は時間として読めません。数字で入れてください。`;
      loose.placed = true;
      const previous = { ...f };
      editField(plan, path, value);
      fresh.set(path, previous);
      latest = new Set([path]);
      item.classList.remove("loose");
      item.draggable = false;
      button.remove();
      note.textContent = `→ ${label}に入れました`;
      placedNotes.set(path, note);
      renderAll();
      refreshFindings();
      planRows.get(path).input.focus();
      return null;
    };
    // 値がある欄、時間の欄、置き換えの記号が残る文は、その場で直してから入れる
    if (f.status === "filled" || path.endsWith("Minutes") || changeBoxes.has(path) || typed !== null || /\[(?:お名前|住所|日付|電話番号|郵便番号|手元の値|メール)\]/.test(memo)) askChange(path, f.value, typed ?? memo, put, { focus: true, owner: loose, edited: typed !== null });
    else put(memo);
  }

  function askConflicts(conflicts) {
    for (const c of conflicts) {
      askChange(c.path, c.current, c.proposed, (value) => {
        if (c.path.endsWith("Minutes") && parseMinutes(value) === null) return `「${value}」は時間として読めません。数字で入れてください。`;
        editField(plan, c.path, value);
        fresh.delete(c.path);
        latest.delete(c.path);
        renderAll();
        refreshFindings();
        return null;
      });
    }
  }

  $("addMemo").addEventListener("click", addMemo);
  const cancelMove = () => {
    const from = moving;
    moving = null;
    placing = null;
    renderAll();
    planRows.get(from)?.move.focus();
  };
  $("moveCancel").addEventListener("click", cancelMove);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (moving || placing)) cancelMove();
  });
  $("addPerson").addEventListener("click", () => {
    const name = $("personName").value.trim();
    const alias = $("personAlias").value.trim();
    const phone = $("personPhone").value.replace(/\D/g, "");
    if (!name || !alias) {
      $("memoError").textContent = "名前と呼び名の両方を入れてください。呼び名は「隣の人」のように、続き柄や位置で入れます。";
      $("memoError").hidden = false;
      return;
    }
    $("memoError").hidden = true;
    if (findLeaks(alias, [name]).length > 0) {
      $("memoError").textContent = "呼び名に名前が入っています。「隣の人」のように続き柄や位置で入れてください。";
      $("memoError").hidden = false;
      return;
    }
    known.unshift({ value: name, alias });
    secrets.push(name);
    if (phone) {
      known.push({ value: phone, alias: "[電話番号]", kind: "phone" });
      secrets.push(phone);
    }
    state.people = [...state.people.filter((p) => p.alias !== alias), { name, alias, phone }];
    // 名前を入れただけでは頼んだことにしない。頼めたかどうかは計画の欄で人が印を付ける
    if (!plan.helpers.some((h) => h.alias === alias)) plan.helpers.push({ alias, awayWeekdayDaytime: false, asked: false, memoId: null });
    renderPlan();
    renderPeople();
    $("personName").value = "";
    $("personAlias").value = "";
    $("personPhone").value = "";
    refreshFindings();
  });
  $("nextMemo").hidden = !script;
  $("nextMemo").addEventListener("click", async () => {
    if (!script || scriptIndex >= script.length) return;
    $("memo").value = script[scriptIndex];
    scriptIndex += 1;
    $("nextMemo").hidden = scriptIndex >= script.length;
    await addMemo();
  });
  $("goWrap").addEventListener("click", async () => {
    // 次の一歩に指摘が入るよう、途中の仕事が終わってから進む
    $("goWrap").disabled = true;
    const work = (async () => {
      await scribeQueue.idle().catch(() => {});
      await checker.idle().catch(() => {});
      if (checkError) await checker.request().catch(() => {});
    })();
    // 待ち続けない。残りは訪問終了の画面で知らせる
    const label = $("goWrap").textContent;
    if (state.skipWrapWait) state.skipWrapWait = false;
    else {
      $("goWrap").textContent = "点検の終わりを待っています";
      await Promise.race([work, new Promise((resolve) => setTimeout(resolve, WRAP_WAIT))]);
    }
    $("goWrap").textContent = label;
    $("goWrap").disabled = false;
    if ($("talk").hidden) return;
    state.checkFailed = Boolean(checkError);
    // 復唱して、計画に入れ忘れた文字も数える
    state.unfinishedMemos = () => state.looseMemoTexts().length + ($("memo").value.trim() ? 1 : 0);
    state.findings = () => findings;
    startWrap(state, findings, state.output);
  });
  $("skip").addEventListener("click", () => {
    if (interrupt) {
      plan.nextSteps.push({ topic: interrupt.id, text: interrupt.opener });
      interrupt = null;
      renderOpener();
      return;
    }
    const topic = currentTopic();
    if (topic) {
      skipped.push(topic.id);
      topic.fills.forEach((p) => skippedFields.add(p));
      plan.nextSteps.push({ topic: topic.id, text: topic.text, fills: topic.fills });
    }
    renderOpener();
  });

  // 様式を変えても、話した内容は残す。欄の並びと名前だけを作り直す
  state.refreshFormat = () => {
    const open = [...changeBoxes.keys()].map((path) => changeRetry.get(path)());
    const before = LABEL;
    FIELDS = planFieldList(state);
    // 確かめている途中の欄は、新しい様式に無くても消さない
    for (const { path } of open) {
      if (!FIELDS.some((f) => f.path === path)) FIELDS.push({ path, label: before.get(path) ?? path, kind: null, mark: "様式の外" });
    }
    LABEL = new Map(FIELDS.map((f) => [f.path, f.label]));
    moving = null;
    changeBoxes.clear();
    changeRetry.clear();
    planRows.clear();
    $("planFields").replaceChildren();
    renderAll();
    for (const { path, proposed, apply, owner, edited } of open) {
      askChange(path, getAt(plan, path).value, proposed, apply, { owner, edited });
      showWaiting(path);
    }
    const notes = new Map();
    for (const [path, note] of placedNotes) notes.set(note, [...(notes.get(note) ?? []), LABEL.get(path) ?? path]);
    for (const [note, names] of notes) if (!note.textContent.includes("近くの人")) note.textContent = `→ ${names.join("、")}に入りました`;
    refreshFindings();
  };

  // 計画に入っていない声メモは、続き用ファイルに残し、再開したら戻す
  state.looseMemoTexts = () => {
    const typed = new Map([...changeBoxes.values()].filter((box) => box.owner && box.edited).map((box) => [box.owner.memo, box.querySelector("input").value]));
    return [...new Set([
      ...[...$("memos").querySelectorAll(".pending, .failed, .loose")].map((li) => typed.get(li.firstChild.textContent) ?? li.firstChild.textContent),
      ...[...changeBoxes.values()].filter((box) => !box.owner).map((box) => box.querySelector("input").value),
      ...[...changeQueue.values()].flat().filter((w) => !w.owner).map((w) => w.proposed),
    ])];
  };
  for (const memo of state.looseMemos ?? []) {
    const item = el("li", { textContent: memo });
    $("memos").append(item);
    makeLoose(item, memo);
  }
  renderAll();

  micTalk = startMic(addMemo);
  // 話した内容はこの画面の中だけにある。閉じる前に確かめる
  window.addEventListener("beforeunload", (e) => {
    e.preventDefault();
    e.returnValue = "";
  });
}

const MIC_LABEL = "長押しで復唱／短く押して計画に入れる";
const MIC_ERROR = {
  "not-allowed": "マイクの使用が許可されていません。ブラウザの設定で許可するか、文字で入れてください。",
  "service-not-allowed": "マイクの使用が許可されていません。ブラウザの設定で許可するか、文字で入れてください。",
  "audio-capture": "マイクが見つかりません。文字で入れてください。",
  network: "音声認識につながりません。文字で入れてください。",
};

function startMic(addMemo) {
  const mic = $("mic");
  const status = $("micState");
  const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!Recognition) {
    mic.disabled = true;
    status.textContent = "このブラウザでは声が使えません。文字で入れてください。";
    return;
  }
  let before = "";
  const talk = createPushToTalk({
    Recognition,
    onText: (text) => { $("memo").value = before + text; },
    onInterim: (text) => { if (text) status.textContent = text; },
    onState: (state, detail) => {
      mic.classList.toggle("listening", state === "listening");
      // 文字が届く間は、手で直しても上書きされるので触れないようにする
      const changing = state === "listening" || state === "finishing";
      $("memo").readOnly = changing;
      $("addMemo").disabled = changing;
      mic.textContent = state === "listening" ? "聞いています（離すと止まります）" : MIC_LABEL;
      if (state === "listening") status.textContent = "";
      if (state === "finishing") status.textContent = "文字にしています。";
      if (state === "idle") status.textContent = $("memo").value.trim() ? "文字を確かめて、短く押すと計画に入ります。" : "聞き取れませんでした。もう一度、長押しで話してください。";
      if (state === "tap") {
        status.textContent = $("memo").value.trim() ? "" : "長押ししたまま話してください。";
        addMemo();
      }
      if (state === "error") status.textContent = MIC_ERROR[detail] ?? "声を聞き取れませんでした。文字で入れてください。";
    },
  });
  const press = () => {
    const held = $("memo").value;
    // 続けて復唱したとき、前の文とくっつかないようにする
    if (talk.press()) before = held && !/[。、\s]$/.test(held) ? `${held}。` : held;
  };
  const cancel = () => talk.cancel();
  // 押した指だけを見る。2本目の指で止まったり送られたりしないように
  let pointer = null;
  mic.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || pointer !== null) return;
    pointer = e.pointerId;
    // 指が少しずれても押したままとして扱う
    mic.setPointerCapture(e.pointerId);
    press();
  });
  mic.addEventListener("pointerup", (e) => {
    if (e.pointerId !== pointer) return;
    pointer = null;
    // 指を外へずらして離したら、送るつもりではなかったと見る
    const r = mic.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (inside) talk.release();
    else cancel();
  });
  mic.addEventListener("pointercancel", (e) => {
    if (e.pointerId !== pointer) return;
    pointer = null;
    cancel();
  });
  mic.addEventListener("contextmenu", (e) => e.preventDefault());
  mic.addEventListener("keydown", (e) => {
    if ((e.key === " " || e.key === "Enter") && !e.repeat) press();
    if (e.key === " " || e.key === "Enter") e.preventDefault();
  });
  mic.addEventListener("keyup", (e) => { if (e.key === " " || e.key === "Enter") talk.release(); });
  mic.addEventListener("blur", cancel);
  startMicKey(talk, press);
  // 別の画面へ移ったら、押したままにしない
  document.addEventListener("visibilitychange", () => { if (document.hidden) cancel(); });
  return talk;
}

const KEY_STORE = "micKey";

function readKey() {
  try { return localStorage.getItem(KEY_STORE) || DEFAULT_KEY; } catch { return DEFAULT_KEY; }
}

function saveKey(code) {
  try { localStorage.setItem(KEY_STORE, code); } catch { /* 保存できなくても、開いている間は効く */ }
}

// 足で踏むスイッチなど、手を空けたいときのために録音のキーを選べるようにする。残すのはキーの名前だけ
function startMicKey(talk, press) {
  const change = $("micKeyChange");
  let bound = readKey();
  let choosing = false;
  const show = () => {
    $("micKey").textContent = choosing ? "押してください（Esc で取り消し）" : keyLabel(bound);
    change.hidden = choosing;
  };
  const typing = (target) => Boolean(target.closest?.("input, textarea, select, [contenteditable]"));
  $("micKeyRow").hidden = false;
  show();
  change.addEventListener("click", () => {
    choosing = true;
    change.blur();
    show();
  });
  window.addEventListener("keydown", (e) => {
    if (choosing) {
      e.preventDefault();
      e.stopPropagation();
      const code = chooseKey(e);
      if (code) {
        bound = code;
        saveKey(code);
      }
      if (code || e.key === "Escape") {
        choosing = false;
        show();
      }
      return;
    }
    // Ctrl+C などは、そのままブラウザの操作に任せる
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if ($("talk").hidden || !keyTriggers(keyCode(e), bound, typing(e.target))) return;
    e.preventDefault();
    if (!e.repeat) press();
  }, true);
  window.addEventListener("keyup", (e) => {
    if (keyCode(e) !== bound) return;
    talk.release();
  }, true);
  // 押したまま別の窓へ移ると、離したことが届かない
  window.addEventListener("blur", () => talk.cancel());
}
