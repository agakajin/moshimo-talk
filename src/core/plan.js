// 計画のデータの形。本人を特定する情報は identity に分け、Claude に渡さない
import { normalizeAddress, normalizeDate, normalizeKana, normalizeName, normalizePhone, normalizePostal, normalizeText } from "./normalize.js";
import { parseWeekly, weekdaysWithoutService } from "./schedule.js";
import { redact } from "./redact.js";

export const field = () => ({ value: null, status: "undecided", source: null, memoId: null });
const fromCsv = (value) => ({ value, status: "filled", source: "csv", memoId: null });

export function createPlan() {
  return {
    care: { level: field(), mobility: field(), weekly: field() },
    hazards: { items: field(), noOthers: false },
    evacuation: { place: field(), means: field(), route: field(), prepMinutes: field(), moveMinutes: field() },
    timeBands: field(),
    contactMeans: field(),
    carry: field(),
    considerations: { items: field(), noOthers: false },
    helpers: [],
    requests: [],
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

// 確定した列の対応を使って1行を取り込む。CSV に無い欄は未決定のまま残す
export function importRow({ headers, row, mapping }) {
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

  if (raw["care.level"]) plan.care.level = fromCsv(normalizeText(raw["care.level"]));
  if (raw["care.mobility"]) plan.care.mobility = fromCsv(redact(raw["care.mobility"], known));
  if (raw["care.weekly"]) plan.care.weekly = fromCsv(parseWeekly(raw["care.weekly"]));

  return { identity, plan, notes: raw.notes ?? "" };
}

export function serviceGaps(plan) {
  const weekly = plan.care.weekly.value;
  if (!weekly || weekly.items.length === 0) return null;
  return weekdaysWithoutService(weekly.items);
}
