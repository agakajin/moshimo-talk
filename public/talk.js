// 訪問の画面。声メモは送る前に伏せ、送る中身をそのまま見せる
import { applyUpdates, editField, planForClaude, serviceGaps } from "/core/plan.js";
import { findLeaks, redact, redactDeep } from "/core/redact.js";
import { nextTopic, REQUEST_NOTE } from "/core/talk.js";
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
  const secrets = Object.entries(identity).filter(([k]) => k !== "self.gender").map(([, v]) => v).filter(Boolean);
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

  function renderPlan() {
    // 答えは入力の途中でも届くので、打っている欄はそのまま残す
    const active = document.activeElement?.closest?.("#planFields") ? document.activeElement : null;
    const draft = active && { path: active.dataset.path, value: active.value, at: active.selectionStart };
    const rows = FIELDS.map(([path, label]) => {
      const f = getAt(plan, path);
      const input = el("input", { className: "plan-input", value: f.value ?? "", placeholder: "未決定", ariaLabel: label });
      input.dataset.path = path;
      input.addEventListener("change", () => {
        editField(plan, path, input.value);
        renderAll();
        refreshFindings();
      });
      return el("div", { className: `plan-row ${f.status}` },
        el("span", { className: "name", textContent: label }),
        input,
        el("span", { className: "source", textContent: SOURCE[f.source] ?? "" }));
    });
    const helpers = plan.helpers.map((h) => el("div", { className: "plan-row filled" },
      el("span", { className: "name", textContent: "近くの人" }),
      el("span", { textContent: `${h.alias}${h.awayWeekdayDaytime ? "（平日の昼は不在）" : ""}${h.asked ? "" : "・まだ頼んでいない"}` }),
      el("span", { className: "source", textContent: "声メモから" })));
    $("planFields").replaceChildren(...rows, ...helpers);
    if (draft?.path) {
      const input = [...$("planFields").querySelectorAll("input")].find((i) => i.dataset.path === draft.path);
      input.value = draft.value;
      input.focus();
      input.setSelectionRange(draft.at, draft.at);
    }
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

  function addMemo() {
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
        appendConflicts(applyUpdates(plan, data.updates, memoCount, { late }));
        item.className = "";
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
    state.people.push({ name, alias, phone });
    const helper = plan.helpers.find((h) => h.alias === alias);
    if (helper) helper.asked = true;
    else plan.helpers.push({ alias, awayWeekdayDaytime: false, asked: true, memoId: null });
    renderPlan();
    // 名前は画面の中だけ。呼び名で一覧に出す
    $("people").append(el("li", { textContent: `${alias}：入力ずみ` }));
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
    state.unfinishedMemos = () => $("memos").querySelectorAll(".pending, .failed").length;
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

  const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!Recognition) {
    $("mic").disabled = true;
    $("micState").textContent = "このブラウザでは声が使えません。文字で入れてください。";
  } else {
    let recognition = null;
    $("mic").addEventListener("click", () => {
      if (recognition) { recognition.stop(); return; }
      recognition = new Recognition();
      recognition.lang = "ja-JP";
      recognition.interimResults = false;
      recognition.onresult = (e) => { $("memo").value += [...e.results].map((r) => r[0].transcript).join(""); };
      recognition.onerror = (e) => { $("micState").textContent = `声を聞き取れませんでした（${e.error}）。`; };
      recognition.onend = () => { recognition = null; $("mic").textContent = "押して話す"; };
      $("mic").textContent = "止める";
      $("micState").textContent = "";
      recognition.start();
    });
  }
}
