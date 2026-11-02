// 訪問の画面。声メモは送る前に伏せ、送る中身をそのまま見せる
import { applyUpdates, editField, fieldsBefore, moveField, placedFields, planForClaude, serviceGaps } from "/core/plan.js";
import { findLeaks, redact, redactDeep } from "/core/redact.js";
import { nextTopic, REQUEST_NOTE } from "/core/talk.js";
import { chooseKey, createPushToTalk, DEFAULT_KEY, keyCode, keyLabel, keyTriggers } from "/core/voice.js";
import { createLatest, createQueue } from "/core/work.js";
import { startWrap } from "/wrap.js";

const FIELDS = [
  ["hazards.items", "心配な災害"],
  ["home.bedroom", "寝室"],
  ["home.usualRoom", "普段いる部屋"],
  ["home.aloneHours", "ひとりになる時間帯"],
  ["home.community", "自治会名"],
  ["evacuation.place", "逃げる先"],
  ["evacuation.means", "手段"],
  ["evacuation.route", "道のり"],
  ["evacuation.prepMinutes", "準備（分）"],
  ["evacuation.moveMinutes", "移動（分）"],
  ["timeBands", "1週間の過ごし方"],
  ["contactMeans", "知らせの受け方"],
  ["carry", "持ち出し"],
  ["considerations.items", "配慮すること"],
  ["care.level", "要介護度"],
  ["care.mobility", "歩き方"],
  ["care.stairs", "階段の昇り降り"],
  ["care.hearing", "聞こえ方"],
  ["care.household", "同居の有無"],
];
const LABEL = new Map(FIELDS);
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
  const gaps = serviceGaps(plan);
  let scriptIndex = 0;
  let config = null;
  const loadConfig = () => fetch("/samples/hakka-village.config.json").then((r) => r.json()).then((c) => { config = c; }).catch(() => {});
  loadConfig();
  const skipped = [];
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
  const planRows = new Map();
  const helperRows = new Map();
  const scribeQueue = createQueue();
  const checker = createLatest(runCheck);
  const refreshFindings = () => (pendingMemos > 0 ? Promise.resolve() : checker.request());

  const known = [
    { value: identity["self.name"], alias: "本人" },
    { value: identity["self.kana"], alias: "本人" },
    { value: identity["self.address"], alias: "自宅", kind: "address" },
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

  $("talk").hidden = false;
  renderAll();
  renderPeople();
  refreshFindings();

  function renderOpener() {
    const box = $("opener").closest(".opener");
    box.classList.toggle("interrupt", Boolean(interrupt));
    const topic = nextTopic(plan, { gaps, skipped });
    $("openerLabel").textContent = interrupt ? `気になること（${interrupt.yardstick}）` : "話のきっかけ";
    $("opener").textContent = interrupt?.opener ?? topic?.text ?? "ひと通り話せました。";
    $("skip").hidden = !topic && !interrupt;
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
      const text = here.length ? here.map((i) => `${i.kind} ${i.start}〜${i.end}`).join(" ") : isGap ? "昼はどなたが？" : "サービスなし";
      return el("div", { className: `day ${here.length ? "covered" : isGap ? "gap" : ""}` }, el("b", { textContent: d }), text);
    });
    $("talkWeek").replaceChildren(el("div", { className: "week-wrap" }, el("div", { className: "week" }, ...days)));
  }

  function movePlaced(to, options = {}) {
    const from = moving;
    const result = moveField(plan, from, to, { previous: fresh.get(from) ?? null, ...options });
    if (result.reason === "minutes") {
      $("moveText").textContent = `「${getAt(plan, from).value}」は時間として読めないので、${LABEL.get(to)}には移せません。別の欄を選んでください。`;
      return;
    }
    if (result.reason === "occupied") {
      moving = null;
      renderAll();
      askOverwrite(from, to, result.current);
      return;
    }
    if (!result.moved) return;
    fresh.delete(from);
    latest.delete(from);
    fresh.set(to, result.replaced);
    latest.add(to);
    moving = null;
    renderAll();
    planRows.get(to).input.focus();
    refreshFindings();
  }

  function askOverwrite(from, to, current) {
    const value = getAt(plan, from).value;
    const yes = el("button", { className: "button", textContent: "こちらに変える" });
    const box = el("p", { className: "notice" }, `${LABEL.get(to)}の「${current}」を「${value}」に変えますか？ `, yes);
    yes.addEventListener("click", () => {
      // 尋ねている間に欄が変わっていたら、古い話のまま変えない
      if (getAt(plan, from).value !== value) {
        box.replaceChildren("元の欄が変わったので、移すのをやめました。");
        return;
      }
      const now = getAt(plan, to).value;
      box.remove();
      if (now !== null && now !== current) {
        askOverwrite(from, to, now);
        return;
      }
      moving = from;
      movePlaced(to, { overwrite: true });
    });
    $("conflicts").append(box);
    yes.focus();
  }

  // 欄もボタンも作り直さず中身だけ変える。作り直すと、Tab で移った先や、押している途中のボタンが消える
  function buildPlanRows() {
    for (const [path, label] of FIELDS) {
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
      const move = el("button", { className: "button mini", type: "button", textContent: "移す", ariaLabel: `${label}の内容を別の欄へ移す` });
      move.addEventListener("click", () => {
        moving = path;
        renderAll();
        $("moveCancel").focus();
      });
      const here = el("button", { className: "button mini", type: "button", textContent: "ここへ", ariaLabel: `${label}へ移す` });
      const row = el("div", {}, el("span", { className: "name", textContent: label }), input, el("span", { className: "source" }, note, move, here));
      // 移している間は、行のどこを押しても行き先になる
      row.addEventListener("click", () => {
        if (moving && moving !== path) movePlaced(path);
      });
      planRows.set(path, { row, input, note, move, here });
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

  function renderPeople() {
    // 名前は画面の中だけ。呼び名で一覧に出す
    $("people").replaceChildren(...state.people.map((p) => el("li", { textContent: `${p.alias}：入力ずみ` })));
  }

  function renderPlan() {
    if (planRows.size === 0) buildPlanRows();
    for (const [path, { row, input, note, move, here }] of planRows) {
      const f = getAt(plan, path);
      const isLatest = latest.has(path);
      row.className = `plan-row ${f.status}${isLatest ? " fresh" : ""}${moving === path ? " moving" : ""}${moving && moving !== path ? " target" : ""}`;
      // 打っている欄の文字は消さない。移している間は打っていないので、行き先にも値を見せる
      if (document.activeElement !== input || input.readOnly) input.value = f.value ?? "";
      input.readOnly = Boolean(moving);
      note.textContent = moving === path ? "これを移します" : moving ? "" : isLatest ? (f.source === "human" ? "移しました" : "いま入った") : SOURCE[f.source] ?? "";
      move.hidden = Boolean(moving) || !fresh.has(path) || f.status !== "filled";
      here.hidden = !moving || moving === path;
    }
    $("moveBar").hidden = !moving;
    if (moving) $("moveText").textContent = `「${getAt(plan, moving).value}」を、どの欄に移しますか？`;
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
    renderWork();
    renderRequests();
    try {
      const body = guarded({ plan: planToSend(), gaps });
      showSent("点検役へ", body);
      const data = await post("/api/check", body);
      if (outdated()) return;
      markMode(data.mode);
      findings = data.findings;
      checkError = "";
      interrupt = findings.find((f) => f.interrupt && !shownInterrupts.has(f.id)) ?? null;
      if (interrupt) shownInterrupts.add(interrupt.id);
    } catch (e) {
      if (outdated()) return;
      // 「ありません」と見えないよう、点検できなかったことを出す
      checkError = `点検できませんでした。${e.message}`;
    } finally {
      checking = false;
      renderWork();
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
        const body = guarded({ memo, plan: planToSend() });
        showSent("書き取り役へ", body);
        const data = await post("/api/scribe", body);
        markMode(data.mode);
        memoCount += 1;
        const before = fieldsBefore(plan, data.updates);
        const conflicts = applyUpdates(plan, data.updates, memoCount, { late });
        appendConflicts(conflicts);
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
        if (names.length > 0) item.append(el("small", { className: "placed", textContent: `→ ${names.join("、")}に入りました` }));
        else if (conflicts.length === 0 && !data.updates.some((u) => u.path.endsWith(".noOthers"))) item.append(el("small", { className: "placed", textContent: "→ どの欄にも入りませんでした。文字を確かめるか、欄に直接入れてください" }));
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

  function appendConflicts(conflicts) {
    $("conflicts").append(...conflicts.map((c) => {
      const yes = el("button", { className: "button", textContent: "こちらに変える" });
      const box = el("p", { className: "notice" }, `「${c.current}」を「${c.proposed}」に変えますか？ `, yes);
      yes.addEventListener("click", () => {
        editField(plan, c.path, c.proposed);
        box.remove();
        renderAll();
        refreshFindings();
      });
      return box;
    }));
  }

  $("addMemo").addEventListener("click", addMemo);
  const cancelMove = () => {
    const from = moving;
    moving = null;
    renderAll();
    planRows.get(from)?.move.focus();
  };
  $("moveCancel").addEventListener("click", cancelMove);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && moving) cancelMove();
  });
  $("addPerson").addEventListener("click", () => {
    const name = $("personName").value.trim();
    const alias = $("personAlias").value.trim();
    const phone = $("personPhone").value.replace(/\D/g, "");
    if (!name || !alias) return;
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
    // 待ち続けない。残りは帰る前の画面で知らせる
    await Promise.race([work, new Promise((resolve) => setTimeout(resolve, WRAP_WAIT))]);
    if (!config) await loadConfig();
    $("goWrap").disabled = false;
    if (!config) {
      $("memoError").textContent = "画面の設定を読めませんでした。電波を確かめて、もう一度押してください。";
      $("memoError").hidden = false;
      return;
    }
    state.checkFailed = Boolean(checkError);
    // 復唱して、計画に入れ忘れた文字も数える
    state.unfinishedMemos = () => $("memos").querySelectorAll(".pending, .failed").length + ($("memo").value.trim() ? 1 : 0);
    startWrap(state, findings, config);
  });
  $("skip").addEventListener("click", () => {
    if (interrupt) {
      plan.nextSteps.push({ topic: interrupt.id, text: interrupt.opener });
      interrupt = null;
      renderOpener();
      return;
    }
    const topic = nextTopic(plan, { gaps, skipped });
    if (topic) {
      skipped.push(topic.id);
      plan.nextSteps.push({ topic: topic.id, text: topic.text });
    }
    renderOpener();
  });

  micTalk = startMic(addMemo);
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
    if ($("talk").hidden || keyCode(e) !== bound) return;
    talk.release();
  }, true);
  // 押したまま別の窓へ移ると、離したことが届かない
  window.addEventListener("blur", () => talk.cancel());
}
