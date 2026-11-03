// 訪問終了で出すもの。すべて決まった通りにプログラムで作る。AI に値を作らせない
import { parseMinutes } from "./normalize.js";
import { askedHelpers, DEFAULT_TARGETS } from "./format.js";
import { nameParts } from "./redact.js";
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
  "home.aloneHours": "ひとりになる時間帯",
  "care.stairs": "階段",
  "care.hearing": "聞こえ方",
  "considerations.items": "配慮すること",
};
const getAt = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);

export function totalMinutes(plan) {
  if (!filled(plan.evacuation.moveMinutes)) return null;
  const move = parseMinutes(val(plan.evacuation.moveMinutes));
  const prep = filled(plan.evacuation.prepMinutes) ? parseMinutes(val(plan.evacuation.prepMinutes)) : 0;
  // 読めない時間を 0 にすると、本人の紙に短く出てしまう
  return move === null || prep === null ? null : prep + move;
}

const WAITING = "（手伝う人の同意待ち）";
const PERSON_WORD = /隣|近所|近くの人|向かい|親子|娘|むすめ|息子|嫁|婿|孫|(?<![丈工農])夫|妻|兄|姉(?!妹都市)|弟|妹(?!都市)|母(?!屋|子セ)|父|親|甥|姪|いとこ|おじ|おば(?!け)|じいちゃん|ばあちゃん|長男|次男|三男|長女|次女|三女|主人|旦那|家内|家族|友人|友達|友だち|知人|知り合い|区長|会長|班長|組長|民生委員|ヘルパー|ケアマネ|看護師|大家|消防団|先生|の人|人が|職員|社協|姑|舅|倅|連れ合い|幼なじみ|同級生|同窓|仲間|教え子|おっちゃん|となり|かあちゃん|にいちゃん|ねえちゃん|とうちゃん|せがれ|だんな|むすこ|若い衆|(?<![自住帰在社別お])宅|(?<!たく)さん|様(?!子)/;
// 人の話に見えるが、場所や体の話の言葉は先に外す。避難先を隠さないため
const NOT_PERSON = /(?:隣|となり|近所|向かい)の?(?:町|村|市|区|部屋|公民館|小学校|中学校|集会所|体育館|神社|寺|公園|病院|集落|地区|避難所|高台|広場)|隣接|親水|親指|親切|親しい|模様|同様|様々/g;
// 同意がないときは、手伝う人に触れた文を市向けに出さない。言葉の一覧には限りがあるので、画面でも人が確かめる
function withoutHelpers(text, plan, people = []) {
  // 名字だけや空白なしで書いても見つける
  const names = [...plan.helpers.map((h) => h.alias), ...people.flatMap((p) => [p.alias, p.name, String(p.name ?? "").replace(/\s/g, ""), ...String(p.name ?? "").split(/\s+/), ...nameParts(p.name)])].filter(Boolean);
  const mentions = (part) => PERSON_WORD.test(part.replace(NOT_PERSON, "")) || names.some((a) => part.includes(a));
  if (!mentions(text)) return text;
  const kept = text.split(/(?<=[。；、])/).filter((part) => !mentions(part)).join("").replace(/[、；]$/, "");
  return kept ? `${kept}${WAITING}` : WAITING;
}

// 準備が未記入なのに「準備を入れて」と言わない
const minutesWords = (plan) => (filled(plan.evacuation.prepMinutes) ? `準備を入れて${totalMinutes(plan)}分` : `移動${totalMinutes(plan)}分（準備の時間はこれから）`);

export function evacuationSentence(plan, whoLabel, people = []) {
  const means = val(plan.evacuation.means);
  const minutes = totalMinutes(plan);
  if (!means || minutes === null) return "";
  // null は「誰と」を出さないとき（手伝う人の同意がない）
  if (whoLabel === null) {
    const shown = withoutHelpers(means, plan, people);
    return shown === means ? `${means}で、${minutesWords(plan)}` : `手段は${WAITING}。${minutesWords(plan)}`;
  }
  return `${whoLabel || "（誰と行くかは未決定）"}${whoLabel ? "と" : "。"}${means}で、${minutesWords(plan)}`;
}

export function buildSummary(plan, findings = [], customs = []) {
  const talked = Object.entries(SECTION_LABEL)
    .filter(([path]) => {
      const f = getAt(plan, path);
      return filled(f) && f.source !== "csv";
    })
    .map(([, label]) => label);
  // 様式から足した欄も、話したなら数える
  for (const { path, label } of customs) {
    const f = getAt(plan, path);
    if (filled(f) && f.source !== "csv") talked.push(label);
  }
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
  const settled = (path) => {
    const f = getAt(plan, path);
    return Array.isArray(f) ? f.length > 0 : filled(f);
  };
  // 飛ばした問いかけは、点検で指摘が消えたら残さない
  const stillAsked = (step) => step.fills || findings.length === 0 || findings.some((f) => f.id === step.topic);
  for (const step of plan.nextSteps) if (!step.fills?.some(settled) && stillAsked(step)) next.push(`次に話す：${step.text}`);
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
      ["どれくらい", totalMinutes(plan) === null ? "" : minutesWords(plan).replace(/(\d+)分/, " $1 分")],
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

// 今の様式に無い分類の同意では出さない。その同意は画面で取り消せないため
export const hasCityConsent = (plan, config) => Object.keys(config?.consentGroups ?? plan.consent).some((g) => plan.consent[g] === "yes");

// 出口の様式に当てはめる。同意していない項目は空にする
export function buildVillageRow({ plan, identity, people = [], config, createdOn, ownNumbers = {} }) {
  const helper = (i) => {
    const h = askedHelpers(plan, people)[i];
    const person = h && people.find((p) => p.alias === h.alias);
    return { name: person?.name ?? "", relation: h?.alias ?? "", phone: formatPhone(person?.phone) };
  };
  const [h1, h2] = [helper(0), helper(1)];
  const open = (f) => (val(f) && plan.consent.helper !== "yes" ? withoutHelpers(val(f), plan, people) : val(f));
  // 話した階段や聞こえ方も市に届くよう、配慮の列にまとめる
  const considerations = [plan.care.mobility, plan.care.stairs, plan.care.hearing, plan.considerations.items].map(open).filter(Boolean).join("；");
  const hazards = [plan.hazards.items, plan.home.hazardNote].map(open).filter(Boolean).join("；");
  const minutes = totalMinutes(plan);
  const direct = {
    "meta.createdOn": createdOn,
    "self.name": identity["self.name"] ?? "",
    "self.kana": identity["self.kana"] ?? "",
    "self.birth": identity["self.birth"] ?? "",
    "self.gender": identity["self.gender"] ?? "",
    "self.postal": identity["self.postal"] ?? "",
    "self.address": identity["self.address"] ?? "",
    "self.phone": formatPhone(identity["self.phone"]),
    "emergency.name": identity["emergency.name"] ?? "",
    "emergency.phone": formatPhone(identity["emergency.phone"]),
    "helper1.name": h1.name,
    "helper1.relation": h1.relation,
    "helper1.phone": h1.phone,
    "helper2.name": h2.name,
    "helper2.relation": h2.relation,
    "helper2.phone": h2.phone,
    "considerations.all": considerations,
    "hazards.all": hazards,
    "evacuation.summary": evacuationSentence(plan, plan.consent.helper === "yes" ? h1.relation : null, people),
    // 列は準備と移動の合計なので、準備が未記入なら数字を出さない
    "evacuation.minutes": minutes === null || !filled(plan.evacuation.prepMinutes) ? "" : String(minutes),
    "care.level": val(plan.care.level),
    none: "",
  };
  const valueOf = (column) => {
    const target = config.targets?.[column] ?? DEFAULT_TARGETS[column];
    if (target === undefined) return "";
    // 番号は読み込んだ計画書の値のまま。無ければ新しく付けず、空で出す
    if (target === "meta.serial") return ownNumbers[column] ?? "";
    return target in direct ? direct[target] : open(getAt(plan, target));
  };
  const allowed = new Set(config.alwaysColumns);
  const optional = new Set(config.columns.filter((c) => ["none", "meta.serial", "helper2.name", "helper2.relation", "helper2.phone"].includes(config.targets?.[c] ?? DEFAULT_TARGETS[c])));
  for (const [group, def] of Object.entries(config.consentGroups)) {
    if (plan.consent[group] === "yes") def.columns.forEach((c) => allowed.add(c));
  }
  return config.columns.map((column) => {
    if (config.neverColumns.includes(column) || !allowed.has(column)) return "";
    const v = valueOf(column);
    return v === "" && !optional.has(column) ? config.blankValue : v;
  });
}

const csvCell = (v) => {
  // 表計算ソフトで数式として動かないようにする
  // 「-5」「+81」のようなただの数字は、元の値を変えないよう印を付けない
  const text = String(v).normalize("NFKC").trimStart();
  const safe = /^[=+\-@]/.test(text) && !/^[+\-][\d.,\s-]*$/.test(text) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsvText(columns, row) {
  return `﻿${columns.map(csvCell).join(",")}\r\n${row.map(csvCell).join(",")}\r\n`;
}
