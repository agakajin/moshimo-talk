// 帰る前の画面。今日できたことと次の一歩、同意、本人の1枚、市向け CSV、続き用ファイル
import { toResumeFile } from "/core/plan.js";
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

export function startWrap(state, findings, config) {
  const { plan } = state;
  $("talk").hidden = true;
  $("wrap").hidden = false;
  window.scrollTo(0, 0);

  function renderSummary() {
    const { done, next } = buildSummary(plan, findings);
    const unfinished = state.unfinishedMemos?.() ?? 0;
    if (unfinished > 0) next.unshift(`計画に入っていない声メモが${unfinished}件あります。話に戻って確かめてください`);
    if (state.checkFailed) next.unshift("点検ができなかったので、気になることの指摘が入っていません。話に戻って「帰る前へ」を押すと、もう一度点検します");
    $("doneList").replaceChildren(...(done.length ? done : ["これから話します"]).map((t) => el("li", { textContent: t })));
    $("nextList").replaceChildren(...(next.length ? next : ["今日はここまでで大丈夫です"]).map((t) => el("li", { textContent: t })));
    $("askedList").replaceChildren(...plan.requests.map((r) => {
      const box = el("input", { type: "checkbox", checked: plan.requestsDone.includes(r) });
      box.addEventListener("change", () => {
        plan.requestsDone = box.checked ? [...plan.requestsDone, r] : plan.requestsDone.filter((x) => x !== r);
        renderSummary();
      });
      return el("label", { className: "request" }, box, el("span", { textContent: `${r} を頼めた` }));
    }));
  }

  function renderConsent() {
    $("consentRows").replaceChildren(...Object.entries(config.consentGroups).map(([group, def]) => {
      const select = el("select", { ariaLabel: def.label });
      for (const [value, label] of CONSENT_OPTIONS) select.append(el("option", { value, textContent: label }));
      select.value = plan.consent[group];
      select.addEventListener("change", () => {
        plan.consent[group] = select.value;
        renderCsvPreview();
      });
      return el("div", { className: "plan-row consent-row" }, el("span", { className: "name", textContent: def.label }), select);
    }));
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
    const today = new Date().toISOString().slice(0, 10);
    return buildVillageRow({ ...state, config, createdOn: today });
  }

  function renderCsvPreview() {
    const allowed = hasCityConsent(plan);
    $("csvBlocked").hidden = allowed;
    $("csvDownload").disabled = !allowed;
    if (!allowed) { $("csvPreview").replaceChildren(); return; }
    const row = csvRow();
    $("csvPreview").replaceChildren(...config.columns.map((c, i) => el("tr", {},
      el("td", { textContent: c }), el("td", { textContent: row[i], className: String(row[i]).includes("同意待ち") ? "waiting" : "" }))));
  }

  // 帰る前の画面を開いたあとに書き取りが終わることがある
  state.refreshWrap = () => {
    if ($("wrap").hidden) return;
    renderSummary();
    renderSheet();
    renderCsvPreview();
  };
  renderSummary();
  renderConsent();
  renderSheet();
  renderCsvPreview();

  $("print").onclick = () => { renderSheet(); window.print(); };
  $("csvDownload").onclick = () => download("hakka-village-plan.csv", toCsvText(config.columns, csvRow()), "text/csv;charset=utf-8");
  $("resumeDownload").onclick = () => download("hinan-hanashi-resume.json", JSON.stringify(toResumeFile(state), null, 2), "application/json");
  $("backToTalk").onclick = () => {
    $("wrap").hidden = true;
    $("talk").hidden = false;
    window.scrollTo(0, 0);
  };
}
