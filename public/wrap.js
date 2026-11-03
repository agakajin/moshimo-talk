// 訪問終了の画面。今日できたことと次の一歩、同意、本人の1枚、個別避難計画書の CSV、ケアプラン用の CSV、続き用ファイル
import { toResumeFile } from "/core/plan.js";
import { askedHelpers, buildInputRow, GROUP_LABEL, hasInputConsent, inputConsentGroups, planFieldList, requiredBlanks } from "/core/format.js";
import { pendingRechecks } from "/core/merge.js";
import { buildOneSheet, buildSummary, buildVillageRow, hasCityConsent, toCsvText } from "/core/output.js";
import { REQUEST_NOTE } from "/core/talk.js";

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const CONSENT_OPTIONS = [["unasked", "まだ聞いていない"], ["yes", "渡してよい"], ["no", "渡さない"]];
const INPUT_OPTIONS = [["unasked", "まだ聞いていない"], ["yes", "戻してよい"], ["no", "戻さない"]];

export function startWrap(state, findings, config) {
  const { plan } = state;
  $("talk").hidden = true;
  $("wrap").hidden = false;
  document.querySelector(".top h1").textContent = "訪問終了";
  document.querySelector(".top p").textContent = "今日できたことを確かめて、本人の1枚と渡すものを作ります。";
  window.scrollTo(0, 0);

  function renderSummary() {
    const { done, next } = buildSummary(plan, state.findings?.() ?? findings, state.customs);
    for (const { label } of pendingRechecks(state)) next.unshift(`次に確かめる：${label}（2つのデータで違っていました）`);
    const unfinished = state.unfinishedMemos?.() ?? 0;
    if (unfinished > 0) next.unshift(`計画に入っていない話が${unfinished}件あります（声メモ、確認の途中の案）。話に戻って確かめてください`);
    if (state.checking) next.unshift("いま点検しています。終わると、ここに指摘が入ります");
    if (state.checkFailed && !state.checking) next.unshift("点検ができなかったので、気になることの指摘が入っていません。話に戻って「訪問終了」を押すと、もう一度点検します");
    $("doneList").replaceChildren(...(done.length ? done : ["これから話します"]).map((t) => el("li", { textContent: t })));
    $("nextList").replaceChildren(...(next.length ? next : ["今日はここまでで大丈夫です"]).map((t) => el("li", { textContent: t })));
    $("askedHead").hidden = plan.requests.length === 0;
    $("askedList").replaceChildren(...plan.requests.map((r) => {
      const box = el("input", { type: "checkbox", checked: plan.requestsDone.includes(r) });
      box.addEventListener("change", () => {
        plan.requestsDone = box.checked ? [...plan.requestsDone, r] : plan.requestsDone.filter((x) => x !== r);
        renderSummary();
      });
      return el("label", { className: "request" }, box, el("span", { textContent: `${r} を頼めた` }));
    }));
  }

  // 同意をまとめて変える。項目ごとの欄と同じ値を入れるだけなので、あとから1つずつ直せる
  function renderBulk(id, options, groups, store, after) {
    $(id).replaceChildren(el("span", { className: "hint", textContent: "まとめて変える：" }), ...options.map(([value, label]) => {
      const button = el("button", { className: "button mini", type: "button", textContent: label });
      button.addEventListener("click", () => {
        for (const group of groups) store[group] = value;
        after();
      });
      return button;
    }));
  }

  function renderConsent() {
    renderBulk("consentAll", CONSENT_OPTIONS, Object.keys(config.consentGroups), plan.consent, () => {
      state.consentReset = false;
      renderConsent();
      renderCsvPreview();
    });
    $("consentAlways").textContent = config.alwaysColumns?.length ? `同意が1つでもあれば、次の列は本人を確かめるために一緒に出ます：${config.alwaysColumns.join("、")}` : "";
    $("consentReset").hidden = !state.consentReset;
    $("consentRows").replaceChildren(...Object.entries(config.consentGroups).map(([group, def]) => {
      const select = el("select", { ariaLabel: def.label });
      for (const [value, label] of CONSENT_OPTIONS) select.append(el("option", { value, textContent: label }));
      select.value = plan.consent[group];
      select.addEventListener("change", () => {
        plan.consent[group] = select.value;
        state.consentReset = false;
        $("consentReset").hidden = true;
        renderCsvPreview();
      });
      return el("div", { className: "plan-row consent-row" }, el("span", { className: "name", textContent: group === "other" ? `${def.label}（${def.columns.join("、")}）` : def.label }), select);
    }));
  }

  // 話して入れたのに、どの列にも入らない内容を隠さない
  function renderOutside() {
    const at = (path) => path.split(".").reduce((o, k) => o?.[k], plan);
    const outside = planFieldList(state).filter((f) => f.kind !== "plan" && f.kind !== "both" && at(f.path)?.status === "filled" && at(f.path)?.source !== "csv").map((f) => f.label);
    // 様式の列より多く頼めた人も、黙って落とさない
    const helperColumns = Object.values(config.targets ?? {}).filter((t) => /^helper\d\.(?:name|relation)$/.test(t)).map((t) => t.split(".")[0]);
    askedHelpers(plan, state.people ?? []).slice(new Set(helperColumns).size).forEach((h) => outside.push(`手伝う人（${h.alias}）`));
    $("outsideList").hidden = outside.length === 0;
    $("outsideList").textContent = `この様式の列には入らない内容があります：${outside.join("、")}`;
  }

  // 渡す前に、空のまま出る欄を見せる
  function renderRequired() {
    const { fields, local, helper } = requiredBlanks(state);
    const names = [...new Set([...fields.values(), ...(helper ? [helper] : []), ...local])];
    $("requiredList").hidden = names.length === 0;
    $("requiredList").textContent = `様式の欄が${names.length}件空いています。「${config.blankValue ?? "未決定"}」のまま出ます：${names.join("、")}`;
  }

  function renderInput() {
    $("inputPanel").hidden = !state.input;
    if (!state.input) return;
    renderBulk("inputConsentAll", INPUT_OPTIONS, inputConsentGroups(state), plan.consentInput, renderInput);
    $("inputConsentRows").replaceChildren(...inputConsentGroups(state).map((group) => {
      // 「その他」だけでは何の同意か分からないので、列の名前を出す
      const others = Object.entries(state.input.mapping).filter(([, t]) => t.startsWith("extra.")).map(([h]) => h);
      const label = group === "other" ? `${GROUP_LABEL.other}（${others.join("、")}）` : GROUP_LABEL[group];
      const select = el("select", { ariaLabel: `${label}をケアプランへ戻すか` });
      for (const [value, text] of INPUT_OPTIONS) select.append(el("option", { value, textContent: text }));
      select.value = plan.consentInput[group];
      select.addEventListener("change", () => {
        plan.consentInput[group] = select.value;
        renderInputChanges();
      });
      return el("div", { className: "plan-row consent-row" }, el("span", { className: "name", textContent: label }), select);
    }));
    renderInputChanges();
  }

  function renderInputChanges() {
    const allowed = hasInputConsent(state);
    $("inputBlocked").hidden = allowed;
    $("inputDownload").disabled = !allowed;
    const { changes, kept } = buildInputRow({ input: state.input, plan, fromOutput: state.fromOutput });
    const keptRows = kept.map((header) => el("li", { textContent: `${header}：欄を空にしましたが、元の値のまま戻します` }));
    $("inputChanges").replaceChildren(...keptRows, ...(changes.length
      ? changes.map((c) => el("li", { textContent: `${c.header}：${c.allowed ? `「${c.to}」に変えます` : `同意がないので元のまま（話では「${c.to}」）`}` }))
      : keptRows.length ? [] : [el("li", { className: "hint", textContent: "話で変わった欄はありません。" })]));
  }

  function renderSheet() {
    const sheet = buildOneSheet(state);
    $("sheetName").textContent = sheet.name ? `${sheet.name} さんの もしものとき` : "もしものとき";
    $("sheetKana").textContent = sheet.kana;
    $("sheetRows").replaceChildren(...sheet.rows.flatMap(([k, v]) => [
      el("dt", { textContent: k }),
      el("dd", { textContent: v || "これから決めます" }),
    ]));
    $("sheetRequests").replaceChildren(...sheet.requests.map((r) => el("li", {}, r, el("small", { textContent: REQUEST_NOTE }))));
    $("sheetRequestsBox").hidden = sheet.requests.length === 0;
    $("sheetNotes").replaceChildren(...sheet.notes.map((n) => el("p", { textContent: n })));
  }

  function csvRow() {
    // 朝のうちに前の日にならないよう、手元の日付で作る
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    return buildVillageRow({ ...state, config, createdOn: today });
  }

  function renderCsvPreview() {
    const allowed = hasCityConsent(plan, config);
    $("csvBlocked").hidden = allowed;
    $("csvCheckHint").hidden = !allowed;
    $("csvDownload").disabled = !allowed;
    if (!allowed) { $("csvPreview").replaceChildren(); return; }
    const row = csvRow();
    $("csvPreview").replaceChildren(...config.columns.map((c, i) => el("tr", {},
      el("td", { textContent: c }), el("td", { textContent: row[i], className: String(row[i]).includes("同意待ち") ? "waiting" : "" }))));
  }

  // 訪問終了の画面を開いたあとに書き取りが終わることがある
  state.refreshWrap = () => {
    if ($("wrap").hidden) return;
    renderSummary();
    renderSheet();
    renderCsvPreview();
    renderOutside();
    renderRequired();
    if (state.input) renderInputChanges();
  };
  $("outputTitle").textContent = `${config.name ?? "市"}に渡す個別避難計画書`;
  renderSummary();
  renderConsent();
  renderSheet();
  renderCsvPreview();
  renderOutside();
  renderRequired();
  renderInput();
  renderWrapTabs();

  // 渡す相手ごとにタブで分ける。「そのほか」は全部を並べる。同意は各タブの中にそのまま出す
  function renderWrapTabs() {
    const role = document.body.dataset.role;
    const tabs = [
      ["sheet", "ご本人へ", "sheetPanel"],
      // 民生委員はケアプランを持たないので出さない
      ...(state.input && role !== "minsei" ? [["input", "ケアプランへ", "inputPanel"]] : []),
      ["city", "市へ", "cityPanel"],
    ];
    const all = role === "other";
    state.wrapTab = tabs.some(([key]) => key === state.wrapTab) ? state.wrapTab : "sheet";
    $("wrapTabs").hidden = all;
    $("wrapTabs").replaceChildren(...tabs.map(([key, label]) => {
      const button = el("button", { className: `tab${key === state.wrapTab ? " current" : ""}`, type: "button", textContent: label });
      button.setAttribute("aria-pressed", String(key === state.wrapTab));
      button.addEventListener("click", () => {
        state.wrapTab = key;
        renderWrapTabs();
      });
      return button;
    }));
    const shown = new Set(tabs.map(([, , id]) => id));
    for (const id of ["sheetPanel", "inputPanel", "cityPanel"]) {
      const current = tabs.find(([key]) => key === state.wrapTab)?.[2];
      $(id).classList.toggle("tab-off", !shown.has(id) || (!all && id !== current));
    }
  }

  $("print").onclick = () => { renderSheet(); window.print(); };
  $("csvDownload").onclick = () => download(`${config.name ?? "plan"}-plan.csv`, toCsvText(config.columns, csvRow()), "text/csv;charset=utf-8");
  $("inputDownload").onclick = () => download("careplan-updated.csv", toCsvText(state.input.headers, buildInputRow({ input: state.input, plan, fromOutput: state.fromOutput }).row), "text/csv;charset=utf-8");
  $("resumeDownload").onclick = () => download("hinan-hanashi-resume.json", JSON.stringify(toResumeFile({ ...state, looseMemos: state.looseMemoTexts?.() ?? [] }), null, 2), "application/json");
  $("backToTalk").onclick = () => {
    $("wrap").hidden = true;
    $("talk").hidden = false;
    document.querySelector(".top h1").textContent = "訪問";
    document.querySelector(".top p").textContent = "話を聞いて、段取りと次の一歩を決めます。決めるのはご本人です。";
    window.scrollTo(0, 0);
  };
}
