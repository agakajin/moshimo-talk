// 帰る前に出すもの。すべて決まった通りにプログラムで作る。AI に値を作らせない
const filled = (f) => f?.status === "filled";
const val = (f) => (filled(f) ? f.value : "");

const SECTION_LABEL = {
  "hazards.items": "心配な災害",
  "evacuation.place": "逃げる先",
  "evacuation.means": "手段",
  "evacuation.route": "道のり",
  "evacuation.moveMinutes": "かかる時間",
  timeBands: "1週間の過ごし方",
  contactMeans: "知らせの受け方",
  carry: "持ち出し",
  "home.bedroom": "寝る部屋",
};
const getAt = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);

export function totalMinutes(plan) {
  const prep = Number(val(plan.evacuation.prepMinutes));
  const move = Number(val(plan.evacuation.moveMinutes));
  if (!filled(plan.evacuation.moveMinutes)) return null;
  return (Number.isFinite(prep) ? prep : 0) + (Number.isFinite(move) ? move : 0);
}

export function evacuationSentence(plan, whoLabel) {
  const means = val(plan.evacuation.means);
  const minutes = totalMinutes(plan);
  if (!means || minutes === null) return "";
  // null は「誰と」を出さないとき（手伝う人の同意がない）
  if (whoLabel === null) return `${means}で、準備を入れて${minutes}分`;
  return `${whoLabel || "（誰と行くかは未決定）"}${whoLabel ? "と" : "。"}${means}で、準備を入れて${minutes}分`;
}

export function buildSummary(plan, findings = []) {
  const talked = Object.entries(SECTION_LABEL)
    .filter(([path]) => {
      const f = getAt(plan, path);
      return filled(f) && f.source !== "csv";
    })
    .map(([, label]) => label);
  const done = [];
  if (talked.length) done.push(`話せたこと：${talked.join("、")}`);
  const sentence = evacuationSentence(plan, plan.helpers.filter((h) => h.asked).map((h) => h.alias).join("・"));
  if (sentence) done.push(`見えた段取り：${sentence}`);
  for (const r of plan.requestsDone) done.push(`頼めたこと：${r}`);

  const next = [];
  for (const r of plan.requests) if (!plan.requestsDone.includes(r)) next.push(`頼む：${r}`);
  for (const f of findings) {
    if (f.request && !plan.requests.includes(f.request)) next.push(`次に考える：${f.request}`);
    if (!f.request) next.push(`次に話す：${f.text}`);
  }
  for (const step of plan.nextSteps) next.push(`次に話す：${step.text}`);
  if (!filled(plan.evacuation.place)) next.push("次に話す：どこへ逃げるか");
  if (plan.helpers.length === 0) next.push("次に話す：ご近所で顔を知っている方");
  return { done, next: [...new Set(next)] };
}

export function buildOneSheet({ plan, identity, people = [] }) {
  const named = plan.helpers.filter((h) => h.asked).map((h) => people.find((p) => p.alias === h.alias)?.name ?? h.alias);
  return {
    name: identity["self.name"] ?? "",
    kana: identity["self.kana"] ?? "",
    rows: [
      ["どこへ", val(plan.evacuation.place)],
      ["誰と", named.join("、")],
      ["何で", val(plan.evacuation.means)],
      ["どれくらい", totalMinutes(plan) === null ? "" : `準備を入れて ${totalMinutes(plan)} 分`],
      ["持って出るもの", val(plan.carry)],
      ["連絡先", identity["emergency.name"] ? `${identity["emergency.name"]} ${formatPhone(identity["emergency.phone"])}`.trim() : ""],
    ],
    requests: plan.requests,
    notes: [
      "これは下書きです。決めるのはご本人とご家族、支援する人です。",
      "お願いした方が、必ず来られるとは限りません。",
    ],
  };
}

export function formatPhone(digits) {
  if (!digits) return "";
  if (digits.length === 11) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  // 区切りが無いと、Excel で開いたときに先頭の 0 が消える。市外局番の長さは分からないので、4桁で区切る
  if (digits.length === 10) return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
  return digits;
}

export const hasCityConsent = (plan) => Object.values(plan.consent).some((v) => v === "yes");

// ハッカ村の形に当てはめる。同意していない項目は空にする
export function buildVillageRow({ plan, identity, people = [], config, createdOn, serial = "仮-0001" }) {
  const helper = (i) => {
    const h = plan.helpers.filter((x) => x.asked)[i];
    const person = h && people.find((p) => p.alias === h.alias);
    return { name: person?.name ?? "", relation: h?.alias ?? "", phone: formatPhone(person?.phone) };
  };
  const [h1, h2] = [helper(0), helper(1)];
  const considerations = [val(plan.care.mobility), val(plan.considerations.items)].filter(Boolean).join("；");
  const values = {
    管理番号: serial,
    氏名: identity["self.name"] ?? "",
    ふりがな: identity["self.kana"] ?? "",
    生年月日: identity["self.birth"] ?? "",
    性別: identity["self.gender"] ?? "",
    住所: identity["self.address"] ?? "",
    自治会名: val(plan.home.community),
    普段いる部屋: val(plan.home.usualRoom),
    寝室の場所: val(plan.home.bedroom),
    ひとりになる時間帯: val(plan.home.aloneHours),
    電話番号: formatPhone(identity["self.phone"]),
    携帯電話: "",
    避難場所: val(plan.evacuation.place),
    避難支援者1氏名: h1.name,
    避難支援者1続柄: h1.relation,
    避難支援者1電話: h1.phone,
    避難支援者2氏名: h2.name,
    避難支援者2続柄: h2.relation,
    避難支援者2電話: h2.phone,
    緊急連絡先1氏名: identity["emergency.name"] ?? "",
    緊急連絡先1電話: formatPhone(identity["emergency.phone"]),
    避難時の配慮事項: considerations,
    要介護度: val(plan.care.level),
    自宅の災害リスク: val(plan.hazards.items),
    避難方法: evacuationSentence(plan, plan.consent.helper === "yes" ? h1.relation : null),
    特記事項: "",
    作成日: createdOn,
  };
  const allowed = new Set(config.alwaysColumns);
  const optional = new Set(["携帯電話", "避難支援者2氏名", "避難支援者2続柄", "避難支援者2電話", "特記事項"]);
  for (const [group, def] of Object.entries(config.consentGroups)) {
    if (plan.consent[group] === "yes") def.columns.forEach((c) => allowed.add(c));
  }
  return config.columns.map((column) => {
    if (config.neverColumns.includes(column) || !allowed.has(column)) return "";
    const v = values[column] ?? "";
    return v === "" && !optional.has(column) ? config.blankValue : v;
  });
}

const csvCell = (v) => {
  // 表計算ソフトで数式として動かないようにする
  const safe = /^[=+\-@]/.test(String(v).normalize("NFKC").trimStart()) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsvText(columns, row) {
  return `﻿${columns.map(csvCell).join(",")}\r\n${row.map(csvCell).join(",")}\r\n`;
}
