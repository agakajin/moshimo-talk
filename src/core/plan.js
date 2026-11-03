// 計画のデータの形。本人を特定する情報は identity に分け、Claude に渡さない
import { normalizeAddress, normalizeDate, normalizeKana, normalizeName, normalizePhone, normalizePostal, normalizeText, parseMinutes } from "./normalize.js";
import { parseWeekly, weekdaysWithoutService } from "./schedule.js";

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
    // 様式にあって計画の欄に無いもの。見出しは手元に置き、ここは番号で持つ
    extra: {},
    helpers: [],
    requests: [],
    requestsDone: [],
    nextSteps: [],
    consent: {
      contact: "unasked",
      care: "unasked",
      evacuation: "unasked",
      helper: "unasked",
      other: "unasked",
    },
    // 介護ソフトへ戻してよいか。市に渡す同意とは相手が違うので分ける
    consentInput: {
      contact: "unasked",
      care: "unasked",
      evacuation: "unasked",
      helper: "unasked",
      other: "unasked",
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
  const resolved = { ...mapping };
  const customs = [];
  headers.forEach((h, i) => {
    if (!mapping[h]) return;
    const value = (row[i] ?? "").trim();
    // 計画に無い列は、聞く欄として足す
    if (mapping[h] === "new") {
      const key = `x${customs.length + 1}`;
      plan.extra[key] = field();
      if (value) setField(plan, `extra.${key}`, value, source);
      customs.push({ key, path: `extra.${key}`, label: h });
      resolved[h] = `extra.${key}`;
      return;
    }
    raw[mapping[h]] = value;
  });

  for (const [key, normalize] of Object.entries(IDENTITY)) {
    if (raw[key]) identity[key] = normalize(raw[key]);
  }
  // 計画には元の言葉を残す。手元の画面と市向けの出力に使うため。置き換えるのは送る直前だけ
  if (raw["care.level"]) setField(plan, "care.level", raw["care.level"], source);
  if (raw["care.weekly"]) setField(plan, "care.weekly", parseWeekly(raw["care.weekly"]), source);
  for (const path of TEXT_FIELDS) {
    if (raw[path]) setField(plan, path, raw[path], source);
  }

  // 手で入れたときは入口の様式が無いので、入口へは書き出さない
  const input = source === "csv" ? { headers, row, mapping: resolved } : null;
  return { identity, plan, notes: raw.notes ?? "", people: [], customs, input };
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
  // CSV の「計画に無い欄」は中身が分からない（主治医の名前や番号のこともある）ので、値は手元に残す
  for (const f of Object.values(copy.extra ?? {})) if (f.source === "csv" && f.value !== null) f.value = "手元にあります";
  return copy;
}

// 書き取りの結果を計画に入れる。人が直した欄と CSV から来た欄は上書きせず、尋ねるために返す
// late は、失敗したメモをあとから入れ直すとき。新しい話を古い話で消さないよう、尋ねる側に回す
export function applyUpdates(plan, updates, memoId, { late = false } = {}) {
  const conflicts = [];
  for (const { path, value } of updates) {
    if (path === "helpers.add") {
      const { declined, ...helper } = value;
      const known = plan.helpers.find((h) => h.alias === value.alias);
      if (!known) plan.helpers.push({ ...helper, memoId });
      else {
        // あとから「頼んだ」「断られた」と聞いたら直す。人が決めたものは変えない
        if (known.askedBy !== "human") {
          if (value.asked) known.asked = true;
          if (declined) known.asked = false;
        }
        if (value.awayWeekdayDaytime) known.awayWeekdayDaytime = true;
      }
      continue;
    }
    if (path === "hazards.noOthers" || path === "considerations.noOthers") {
      getAt(plan, path.split(".")[0]).noOthers = value === true;
      continue;
    }
    const target = getAt(plan, path);
    if (!target || !("status" in target)) continue;
    if (target.source === "human" || target.source === "csv" || (late && target.status === "filled")) {
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

// 声メモが実際に入れた欄と、入る前の中身を返す。「移す」で元に戻すために使う
export function fieldsBefore(plan, updates) {
  return new Map(updates
    .filter(({ path }) => path !== "helpers.add" && !path.endsWith(".noOthers") && getAt(plan, path) && "status" in getAt(plan, path))
    .map(({ path }) => [path, { ...getAt(plan, path) }]));
}

export function placedFields(plan, before, memoId) {
  return new Map([...before].filter(([path]) => {
    const f = getAt(plan, path);
    return f.source === "voice" && f.memoId === memoId;
  }));
}

// 入れ間違いを人が別の欄へ移す。元の欄は入る前に戻し、行き先に別の値があれば overwrite のときだけ変える
export function moveField(plan, from, to, { previous = null, overwrite = false, value: edited = null } = {}) {
  const source = getAt(plan, from);
  const target = getAt(plan, to);
  const original = source.value;
  // 確認の箱で人が直した値があれば、それを入れる
  const value = edited ?? original;
  if (from === to || source.status !== "filled") return { moved: false, reason: "empty" };
  if (to.endsWith("Minutes") && parseMinutes(value) === null) return { moved: false, reason: "minutes" };
  if (target.status === "filled" && target.value !== value && !overwrite) return { moved: false, reason: "occupied", current: target.value };
  const replaced = { ...target };
  // 同じ話を2回入れていたときは、前の値も入れ間違いなので空に戻す
  Object.assign(source, previous && previous.value !== original ? previous : { value: null, status: "undecided", source: null, memoId: null });
  Object.assign(target, { value, status: "filled", source: "human", memoId: null });
  return { moved: true, replaced };
}

// 続き用ファイル。本人を特定する情報を含むので、書き出した人の責任で扱う
export function toResumeFile({ identity, plan, notes, people, customs = [], input = null, output = null }) {
  return { kind: "hinan-hanashi-resume", version: 1, identity, plan, notes, people, customs, input, output };
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
  plan.extra = data.plan?.extra ?? {};
  return {
    identity: data.identity ?? {},
    plan,
    notes: data.notes ?? "",
    people: Array.isArray(data.people) ? data.people : [],
    customs: Array.isArray(data.customs) ? data.customs : [],
    input: data.input ?? null,
    output: data.output ?? null,
  };
}
