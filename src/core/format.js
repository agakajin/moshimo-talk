// 様式：CSV の見出しと、そこへ入れる内容の対応。入口と出口の2つを持ち、聞く欄は両方を合わせたものにする
// 仕組みは様式の数を問わない。ミント市の見本で3つ目の形を確かめている
import { parseMinutes } from "./normalize.js";
import { field } from "./plan.js";
import { CONTROL, looksLikeValue } from "./mask.js";
import { findLeaks, personalKind } from "./redact.js";

const getAt = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);
const filled = (f) => f?.status === "filled";

// 訪問の画面に出す欄の基本
export const BASE_FIELDS = [
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
  ["home.hazardNote", "家のまわりの危険"],
  ["care.level", "要介護度"],
  ["care.mobility", "歩き方"],
  ["care.stairs", "階段の昇り降り"],
  ["care.hearing", "聞こえ方"],
  ["care.household", "同居の有無"],
];

// 出口の列に入れられる内容
export const OUTPUT_TARGETS = {
  "meta.serial": "元の番号のまま（触らない）",
  "meta.createdOn": "作成日",
  "self.name": "本人の氏名",
  "self.kana": "本人のふりがな",
  "self.birth": "生年月日",
  "self.gender": "性別",
  "self.postal": "郵便番号",
  "self.address": "住所",
  "self.phone": "本人の電話",
  "emergency.name": "緊急連絡先の氏名",
  "emergency.phone": "緊急連絡先の電話",
  "home.community": "自治会名",
  "home.usualRoom": "普段いる部屋",
  "home.bedroom": "寝室",
  "home.aloneHours": "ひとりになる時間帯",
  "evacuation.place": "避難場所",
  "evacuation.means": "避難の手段",
  "evacuation.route": "避難の道のり",
  "evacuation.minutes": "避難にかかる時間（準備と移動）",
  "evacuation.prepMinutes": "避難の準備にかかる時間",
  "evacuation.moveMinutes": "避難の移動にかかる時間",
  "hazards.items": "心配な災害",
  "home.hazardNote": "家のまわりの危険",
  "evacuation.summary": "避難方法（手段と時間の文）",
  "helper1.name": "避難支援者1の氏名",
  "helper1.relation": "避難支援者1の続柄",
  "helper1.phone": "避難支援者1の電話",
  "helper2.name": "避難支援者2の氏名",
  "helper2.relation": "避難支援者2の続柄",
  "helper2.phone": "避難支援者2の電話",
  "considerations.all": "避難時の配慮（歩き方、階段、聞こえ方、配慮すること）",
  "hazards.all": "災害のリスク（心配な災害、家のまわりの危険）",
  "contactMeans": "知らせの受け方",
  "carry": "持ち出し",
  "timeBands": "1週間の過ごし方",
  "care.level": "要介護度",
  "care.mobility": "歩き方",
  "care.stairs": "階段の昇り降り",
  "care.hearing": "聞こえ方",
  "care.household": "同居の有無",
  new: "計画に無い欄（話の中で聞く）",
  none: "空のまま出す",
};

// ハッカ村の見出しの既定。Claude に読ませずに使う
export const DEFAULT_TARGETS = {
  管理番号: "meta.serial",
  氏名: "self.name",
  ふりがな: "self.kana",
  生年月日: "self.birth",
  性別: "self.gender",
  住所: "self.address",
  自治会名: "home.community",
  普段いる部屋: "home.usualRoom",
  寝室の場所: "home.bedroom",
  ひとりになる時間帯: "home.aloneHours",
  電話番号: "self.phone",
  携帯電話: "none",
  避難場所: "evacuation.place",
  避難支援者1氏名: "helper1.name",
  避難支援者1続柄: "helper1.relation",
  避難支援者1電話: "helper1.phone",
  避難支援者2氏名: "helper2.name",
  避難支援者2続柄: "helper2.relation",
  避難支援者2電話: "helper2.phone",
  緊急連絡先1氏名: "emergency.name",
  緊急連絡先1電話: "emergency.phone",
  避難時の配慮事項: "considerations.all",
  要介護度: "care.level",
  自宅の災害リスク: "hazards.all",
  避難方法: "evacuation.summary",
  特記事項: "none",
  作成日: "meta.createdOn",
};

// 1つの列にまとめて入る欄
const EXPANDS = {
  "considerations.all": ["care.mobility", "care.stairs", "care.hearing", "considerations.items"],
  "hazards.all": ["hazards.items", "home.hazardNote"],
  "evacuation.summary": ["evacuation.means", "evacuation.prepMinutes", "evacuation.moveMinutes"],
  "evacuation.minutes": ["evacuation.prepMinutes", "evacuation.moveMinutes"],
};
export const expand = (target) => EXPANDS[target] ?? [target];

// 同意がなくても出す、本人を特定する列
const ALWAYS = new Set(["meta.serial", "meta.createdOn", "self.name", "self.kana", "self.birth", "self.gender", "self.postal", "self.address", "home.community"]);

const GROUP = (target) => {
  if (target.startsWith("extra.")) return "other";
  if (target.startsWith("helper")) return "helper";
  if (target === "self.phone" || target.startsWith("emergency.")) return "contact";
  // 持ち出しは薬、過ごし方は通院の話が入るので、避難先ではなく暮らしの同意で出す
  if (target.startsWith("care.") || target === "considerations.all" || target === "considerations.items" || ["home.usualRoom", "home.bedroom", "home.aloneHours", "carry", "timeBands"].includes(target)) return "care";
  return "evacuation";
};
export const GROUP_LABEL = { contact: "連絡先", care: "歩き方と配慮", evacuation: "避難先と段取り", helper: "手伝う人", other: "その他の項目" };
export const groupOf = GROUP;

function customFor(imported, label) {
  imported.customs ??= [];
  let custom = imported.customs.find((c) => c.label === label);
  if (!custom) {
    const key = `x${imported.customs.length + 1}`;
    imported.plan.extra[key] = field();
    custom = { key, path: `extra.${key}`, label };
    imported.customs.push(custom);
  }
  return custom;
}

// 管理番号や利用者番号は、持ち主ごとに別のもの。つながず、変えず、新しく付けない。電話や郵便の番号は別に扱う
export function isOwnNumberColumn(header) {
  const text = String(header).normalize("NFKC");
  if (/電話|TEL|携帯|FAX|郵便|〒|部屋|号室|連絡先/i.test(text)) return false;
  return /番号|ナンバー|コード|(?:^|[^A-Za-z])(?:ID|No\.?)(?:$|[^A-Za-z])/i.test(text);
}

// 対応は見出しで持つので、同じ見出しが2つあると、別の人の値が出てしまう
export function duplicateHeaders(headers) {
  const seen = new Set();
  return [...new Set(headers.filter((h) => seen.has(h) || !seen.add(h)))];
}

// 見出しは Claude へ送る。送る前に手元の情報と照らし、改行や名前、番号らしいものを見つける
export function suspiciousHeaders(headers, { identity = {}, people = [] } = {}) {
  const secrets = Object.entries(identity).filter(([k, v]) => k !== "self.gender" && v).map(([k, value]) => (k === "self.address" ? { value, kind: "address" } : value));
  for (const p of people) secrets.push(...[p.name, p.phone].filter(Boolean));
  return headers.filter((h) => CONTROL.test(h) || looksLikeValue(h) || personalKind(h) || findLeaks(h, secrets).length > 0);
}

// 確かめた出口の様式を計画につなぐ。計画に無い列は聞く欄として足す。両方の様式にある欄は1つにまとめる
export function attachOutput(imported, { base = {}, name, columns: given }) {
  const columns = given.map((c) => (isOwnNumberColumn(c.header) ? { ...c, target: "meta.serial" } : c));
  const repeated = duplicateHeaders(columns.map((c) => c.header));
  if (repeated.length > 0) throw new Error(`同じ見出しが2つあります：${repeated.join("、")}`);
  const targets = {};
  const groups = {};
  const always = [];
  const never = [];
  for (const { header, target } of columns) {
    const resolved = target === "new" ? customFor(imported, header).path : target;
    targets[header] = resolved;
    if (resolved === "none") never.push(header);
    else if (ALWAYS.has(resolved)) always.push(header);
    else {
      const group = GROUP(resolved);
      groups[group] ??= { label: GROUP_LABEL[group], columns: [] };
      groups[group].columns.push(header);
    }
  }
  // 同意の並びは様式によらずそろえる
  const consentGroups = Object.fromEntries(Object.keys(GROUP_LABEL).filter((g) => groups[g]).map((g) => [g, groups[g]]));
  // 様式が変わると渡す相手が変わるので、前の同意は使わない
  const before = imported.output;
  const changed = !before || before.name !== (name ?? base.name) || JSON.stringify(before.targets) !== JSON.stringify(targets);
  if (changed && imported.plan) {
    // 「渡さない」も聞き直しになるので知らせる。知らせは同意を選び直すまで残す
    if (Object.values(imported.plan.consent).some((v) => v !== "unasked")) imported.consentReset = true;
    for (const group of Object.keys(imported.plan.consent)) imported.plan.consent[group] = "unasked";
  }
  imported.output = {
    ...base,
    name: name ?? base.name,
    blankValue: base.blankValue ?? "未決定",
    columns: columns.map((c) => c.header),
    targets,
    alwaysColumns: always,
    neverColumns: never,
    consentGroups,
  };
  return imported.output;
}

// 続き用ファイルの様式を信じない。見出しを調べ、常に出す列や同意の分類は対応から作り直す
export function checkResumedFormat(imported) {
  const { output, customs = [] } = imported;
  const weekly = imported.plan?.care?.weekly?.value;
  const brokenWeek = weekly !== null && weekly !== undefined && !Array.isArray(weekly.items);
  if (brokenWeek || (output && !Array.isArray(output.columns)) || (imported.input && !Array.isArray(imported.input.headers))) throw new Error("続き用ファイルの形が正しくありません。");
  const headers = [...(output?.columns ?? []), ...customs.map((c) => c.label), ...(imported.input?.headers ?? [])];
  const repeated = [...duplicateHeaders(output?.columns ?? []), ...duplicateHeaders(imported.input?.headers ?? [])];
  if (repeated.length > 0) throw new Error(`同じ見出しが2つあります：${repeated.join("、")}`);
  const suspicious = suspiciousHeaders(headers, imported);
  if (suspicious.length > 0) throw new Error(`見出しに名前や番号らしいものがあります：${suspicious.join("、")}`);
  if (!output) return imported;
  const columns = output.columns.map((header) => ({ header, target: output.targets?.[header] ?? DEFAULT_TARGETS[header] ?? "none" }));
  output.targets = Object.fromEntries(columns.map((c) => [c.header, c.target]));
  attachOutput(imported, { base: output, name: output.name, columns });
  return imported;
}

const MARK = { both: "両方", plan: "避難計画書のみ", care: "ケアプランのみ" };
const ON_SHEET = new Set(["evacuation.place", "evacuation.means", "evacuation.prepMinutes", "evacuation.moveMinutes", "carry"]);

// 聞く欄の一覧。出口の見出しを名前にし、避難計画に入る欄を先に並べる
export function planFieldList({ output, input, customs = [], plan }) {
  const targets = Object.entries(output?.targets ?? {});
  const inPlan = new Set(targets.flatMap(([, t]) => expand(t)));
  const inCare = new Set(Object.values(input?.mapping ?? {}));
  const label = new Map(targets.filter(([, t]) => !EXPANDS[t]).map(([header, t]) => [t, header]));
  // 欄の名前はケアプランの列名を優先し、無ければ計画書の列名を出す
  const careLabel = new Map(Object.entries(input?.mapping ?? {}).map(([header, t]) => [t, header]));
  const row = (path, name) => {
    const kind = inPlan.has(path) ? (inCare.has(path) ? "both" : "plan") : inCare.has(path) ? "care" : null;
    return { path, label: careLabel.get(path) ?? label.get(path) ?? name, kind, mark: MARK[kind] ?? (ON_SHEET.has(path) ? "本人の1枚" : "様式の外") };
  };
  // 様式を変えたあと、前の様式だけの欄は、何か入っているときだけ残す
  const customRows = customs.map((c) => row(c.path, c.label)).filter((r) => r.kind || filled(plan && getAt(plan, r.path)));
  const rows = [...BASE_FIELDS.map(([path, name]) => row(path, name)), ...customRows];
  const rank = (r) => (r.kind === "plan" || r.kind === "both" ? 0 : ON_SHEET.has(r.path) ? 1 : r.kind === "care" ? 2 : 3);
  return rows.map((r, i) => [r, i]).sort(([a, i], [b, j]) => rank(a) - rank(b) || i - j).map(([r]) => r);
}

// 出口の様式で、まだ何も入っていない列。点検に渡す
export function blankColumns(output, plan) {
  if (!output) return [];
  return Object.entries(output.targets ?? {}).filter(([, target]) => {
    if (target === "helper1.name") return !plan.helpers.some((h) => h.asked);
    const paths = expand(target);
    if (!paths.every((p) => getAt(plan, p) && "status" in getAt(plan, p))) return false;
    return !paths.some((p) => filled(getAt(plan, p)));
  }).map(([header]) => header);
}

// どれか1つ入れば足りる列と、全部要る列がある
const ANY_OF = new Set(["considerations.all", "hazards.all"]);

// 頼めた人を、名前のある人から順に並べる。名前のない人が1人目になると、入れた名前が列に届かない
export function askedHelpers(plan, people = []) {
  const named = (h) => Boolean(people.find((p) => p.alias === h.alias)?.name);
  const asked = plan.helpers.filter((h) => h.asked);
  return [...asked.filter(named), ...asked.filter((h) => !named(h))];
}

// 渡す様式で埋める必要があるのに空の欄。話で埋める欄と、手元の情報の欄に分けて返す
export function requiredBlanks({ output, plan, identity = {}, people = [] }) {
  const fields = new Map();
  const local = [];
  let helper = null;
  for (const [header, target] of Object.entries(output?.targets ?? {})) {
    if (target === "helper1.name") {
      const asked = askedHelpers(plan, people);
      if (asked.length === 0) helper = header;
      // 頼めた人の名前は呼び名しかないと空で出る
      else if (!people.find((p) => p.alias === asked[0].alias)?.name) local.push(header);
      continue;
    }
    if (target === "helper2.name") {
      const second = askedHelpers(plan, people)[1];
      if (second && !people.find((p) => p.alias === second.alias)?.name) local.push(header);
      continue;
    }
    if (target.startsWith("self.") || target.startsWith("emergency.")) {
      if (!identity[target]) local.push(header);
      continue;
    }
    const paths = expand(target).filter((p) => getAt(plan, p) && "status" in getAt(plan, p));
    // 「30分から1時間」のように読めない時間は、書き出しで空になるので空きとして見せる
    const empty = paths.filter((p) => !filled(getAt(plan, p)) || (p.endsWith("Minutes") && parseMinutes(getAt(plan, p).value) === null));
    if (empty.length === 0) continue;
    if (ANY_OF.has(target)) {
      if (empty.length === paths.length) fields.set(paths[0], header);
      continue;
    }
    for (const p of empty) fields.set(p, header);
  }
  return { fields, local, helper };
}

// 入口の見出しに行き先があり、話で変わりうる分類だけを聞く。見出しの無いものは戻さず、保存もしない
export function inputConsentGroups({ input, plan }) {
  const groups = new Set(Object.values(input?.mapping ?? {}).filter((t) => {
    const f = getAt(plan, t);
    return f && typeof f === "object" && "status" in f;
  }).map(GROUP));
  return Object.keys(GROUP_LABEL).filter((g) => groups.has(g));
}

// 同意が1つも無ければ、ケアプラン用は保存しない
export const hasInputConsent = ({ input, plan }) => inputConsentGroups({ input, plan }).some((g) => plan.consentInput[g] === "yes");

// 入口と同じ見出しで書き出す。元の値は残し、話で変わった欄だけを、同意があれば入れ替える
export function buildInputRow({ input, plan, fromOutput = [] }) {
  const changes = [];
  const kept = [];
  const row = input.headers.map((header, i) => {
    const raw = input.row[i] ?? "";
    const target = input.mapping[header];
    const f = target && getAt(plan, target);
    // 欄を空にしても、元の値は消さない。そのことを画面で知らせる
    if (f && typeof f === "object" && "status" in f && !filled(f) && raw.trim() !== "") kept.push(header);
    // 個別避難計画書から入った値も、話で変わった値と同じく、同意があれば戻す
    if (!filled(f) || typeof f.value !== "string" || !(["voice", "human"].includes(f.source) || fromOutput.includes(target)) || f.value === raw) return raw;
    const group = GROUP(target);
    const allowed = plan.consentInput[group] === "yes";
    changes.push({ header, from: raw, to: f.value, group, allowed });
    return allowed ? f.value : raw;
  });
  return { row, changes, kept };
}
