// 計画のデータの形。本人を特定する情報は identity に分け、Claude に渡さない
import { normalizeAddress, normalizeDate, normalizeKana, normalizeName, normalizePhone, normalizePostal, normalizeText } from "./normalize.js";
import { parseWeekly, weekdaysWithoutService } from "./schedule.js";
import { redact } from "./redact.js";

export const field = () => ({ value: null, status: "undecided", source: null, memoId: null });

export function createPlan() {
  return {
    care: { level: field(), mobility: field(), weekly: field(), stairs: field(), hearing: field(), household: field() },
    home: { community: field(), usualRoom: field(), bedroom: field(), aloneHours: field(), hazardNote: field() },
    hazards: { items: field(), noOthers: false },
    evacuation: { place: field(), means: field(), route: field(), prepMinutes: field(), moveMinutes: field() },
    timeBands: field(),
    contactMeans: field(),
    carry: field(),
    considerations: { items: field(), noOthers: false },
    helpers: [],
    requests: [],
    requestsDone: [],
    nextSteps: [],
    consent: {
      contact: "unasked",
      care: "unasked",
      evacuation: "unasked",
      helper: "unasked",
    },
  };
}

const IDENTITY = {
  "self.name": normalizeName,
  "self.kana": normalizeKana,
  "self.birth": normalizeDate,
  "self.gender": normalizeText,
  "self.postal": normalizePostal,
  "self.address": normalizeAddress,
  "self.phone": normalizePhone,
  "emergency.name": normalizeName,
  "emergency.phone": normalizePhone,
};
const TEXT_FIELDS = ["care.mobility", "care.stairs", "care.hearing", "care.household", "home.usualRoom", "home.bedroom", "home.hazardNote"];

const getAt = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);
const setField = (plan, path, value, source) => Object.assign(getAt(plan, path), { value, status: "filled", source, memoId: null });

// 確定した列の対応を使って1行を取り込む。無い欄は未決定のまま残す
export function importRow({ headers, row, mapping, source = "csv" }) {
  const identity = {};
  const plan = createPlan();
  const raw = {};
  headers.forEach((h, i) => { if (mapping[h]) raw[mapping[h]] = (row[i] ?? "").trim(); });

  for (const [key, normalize] of Object.entries(IDENTITY)) {
    if (raw[key]) identity[key] = normalize(raw[key]);
  }
  const known = [
    { value: identity["self.name"], alias: "本人" },
    { value: identity["self.kana"], alias: "本人" },
    { value: identity["emergency.name"], alias: "緊急連絡先" },
  ];

  if (raw["care.level"]) setField(plan, "care.level", normalizeText(raw["care.level"]), source);
  if (raw["care.weekly"]) setField(plan, "care.weekly", parseWeekly(raw["care.weekly"]), source);
  for (const path of TEXT_FIELDS) {
    if (raw[path]) setField(plan, path, redact(raw[path], known), source);
  }

  return { identity, plan, notes: raw.notes ?? "", people: [] };
}

export function serviceGaps(plan) {
  const weekly = plan.care.weekly.value;
  if (!weekly || weekly.items.length === 0) return null;
  return weekdaysWithoutService(weekly.items);
}

// Claude に渡す形。読めなかった予定の文には事業所名などが残りうるので外す
export function planForClaude(plan) {
  const copy = structuredClone(plan);
  if (copy.care.weekly.value) delete copy.care.weekly.value.unread;
  return copy;
}

// 書き取りの結果を計画に入れる。人が直した欄は上書きせず、尋ねるために返す
export function applyUpdates(plan, updates, memoId) {
  const conflicts = [];
  for (const { path, value } of updates) {
    if (path === "helpers.add") {
      if (!plan.helpers.some((h) => h.alias === value.alias)) plan.helpers.push({ ...value, memoId });
      continue;
    }
    if (path === "hazards.noOthers" || path === "considerations.noOthers") {
      getAt(plan, path.split(".")[0]).noOthers = value === true;
      continue;
    }
    const target = getAt(plan, path);
    if (!target || !("status" in target)) continue;
    if (target.source === "human") {
      if (target.value !== value) conflicts.push({ path, current: target.value, proposed: value, memoId });
      continue;
    }
    Object.assign(target, { value, status: "filled", source: "voice", memoId });
  }
  return conflicts;
}

export function editField(plan, path, value) {
  const target = getAt(plan, path);
  const text = value.trim();
  Object.assign(target, text === ""
    ? { value: null, status: "undecided", source: null, memoId: null }
    : { value: text, status: "filled", source: "human", memoId: null });
}

// 続き用ファイル。本人を特定する情報を含むので、書き出した人の責任で扱う
export function toResumeFile({ identity, plan, notes, people }) {
  return { kind: "hinan-hanashi-resume", version: 1, identity, plan, notes, people };
}

function mergeShape(base, loaded) {
  if (Array.isArray(base)) return Array.isArray(loaded) ? loaded : base;
  if (base === null || typeof base !== "object") return loaded ?? base;
  const out = {};
  for (const key of Object.keys(base)) out[key] = key in (loaded ?? {}) ? mergeShape(base[key], loaded[key]) : base[key];
  return out;
}

export function fromResumeFile(data) {
  if (data?.kind !== "hinan-hanashi-resume" || data.version !== 1) throw new Error("続き用ファイルではありません");
  const plan = mergeShape(createPlan(), data.plan);
  // 値の欄は mergeShape が null 既定で落とさないよう、読み込んだものを優先する
  for (const path of ["care", "home", "evacuation"]) {
    for (const key of Object.keys(plan[path])) if (data.plan?.[path]?.[key]) plan[path][key] = data.plan[path][key];
  }
  for (const key of ["timeBands", "contactMeans", "carry"]) if (data.plan?.[key]) plan[key] = data.plan[key];
  for (const key of ["hazards", "considerations"]) if (data.plan?.[key]?.items) plan[key].items = data.plan[key].items;
  return { identity: data.identity ?? {}, plan, notes: data.notes ?? "", people: Array.isArray(data.people) ? data.people : [] };
}
