// サーバーの入口で、記号以外や、番号・日付・住所・名前の形を調べる。手元に無い値の照合はできないので、ブラウザの置き換えとあわせて守る
import { CONTROL, looksLikeValue } from "../core/mask.js";
import { createPlan } from "../core/plan.js";
import { personalKind } from "../core/redact.js";

const SYMBOL = /^(?:空|(?:文字列|電話番号|郵便番号|住所|日付)\d+)$/;
const MAX_COLUMNS = 200;
const MAX_HEADER = 60;

export function validateColumnsPayload(payload) {
  const errors = [];
  const columns = payload?.columns;
  if (!Array.isArray(columns) || columns.length === 0 || columns.length > MAX_COLUMNS) {
    return ["列の一覧の形が正しくありません"];
  }
  const extraTop = Object.keys(payload).filter((k) => k !== "columns" && k !== "kind");
  if (extraTop.length > 0) errors.push("決まった項目以外が入っています");
  if ("kind" in payload && payload.kind !== "output") errors.push("様式の種類が正しくありません");

  columns.forEach((c, i) => {
    const extra = Object.keys(c ?? {}).filter((k) => !["header", "withheld", "samples"].includes(k));
    if (extra.length > 0) errors.push(`${i + 1}列目：決まった項目以外が入っています`);
    if (typeof c?.header !== "string" || c.header.length === 0 || c.header.length > MAX_HEADER) {
      errors.push(`${i + 1}列目：見出しの形が正しくありません`);
    } else if (looksLikeValue(c.header)) {
      errors.push(`${i + 1}列目：見出しに本物の値らしいものがあります`);
    } else if (CONTROL.test(c.header) || personalKind(c.header)) {
      // 足した欄の見出しは訪問のたびに送る。あとで止めると直す場所がないので、ここで止める
      errors.push(`${i + 1}列目：見出しに改行や名前らしいものがあります`);
    }
    if (!Array.isArray(c?.samples) || !c.samples.every((s) => typeof s === "string" && SYMBOL.test(s))) {
      errors.push(`${i + 1}列目：記号でない値が入っています`);
    }
    if (c?.withheld === true && c.samples?.length > 0) errors.push(`${i + 1}列目：送らない列に値が入っています`);
  });
  return errors;
}

// 様式の列は200まで。列が多い様式でも訪問の途中で止まらないよう、余裕をみる
const LIMIT = 40000;
// 画面の上限は1000字。伏せると長くなるので、入口は余裕をみる
const MAX_MEMO = 3000;
const PLAN_KEYS = new Set(Object.keys(createPlan()));
const HELPER_KEYS = new Set(["alias", "asked", "askedBy", "awayWeekdayDaytime", "memoId"]);

// 値だけでなく、項目の名前と数字も調べる。1字ずつの配列はつなげて見る
function strings(node, out = []) {
  if (typeof node === "string") out.push(node);
  else if (typeof node === "number") out.push(String(node));
  else if (Array.isArray(node)) {
    if (node.length > 1 && node.every((v) => typeof v === "string" && v.length === 1)) out.push(node.join(""));
    node.forEach((v) => strings(v, out));
  } else if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      out.push(k);
      strings(v, out);
    }
  }
  return out;
}

// 計画の値は文字なので、大きな数字は番号を形の検査から外そうとしたものと見る
const hasBigNumber = (node) => (typeof node === "number" ? Math.abs(node) >= 1e6 : node !== null && typeof node === "object" && Object.values(node).some(hasBigNumber));

// 計画の形にない項目は Claude まで届いてしまうので、入口で断る
const FIELD_KEYS = new Set(["value", "status", "source", "memoId"]);
// 欄の形でないもの（配列に分けた番号や、余分な項目）を通すと、形の検査を避けられる。週の予定だけは値が形を持つ
const badField = (f, weekly = false) => f === null || typeof f !== "object" || Array.isArray(f) || Object.keys(f).some((k) => !FIELD_KEYS.has(k))
  || !(f.value === null || f.value === undefined || typeof f.value === "string" || (weekly && typeof f.value === "object"));
function hasUnknownKeys(plan) {
  const shape = createPlan();
  return Object.entries(plan).some(([section, value]) => {
    const sample = shape[section];
    // 様式から足した欄は番号で持つ
    if (section === "extra") return Object.entries(value ?? {}).some(([k, f]) => !/^x\d{1,3}$/.test(k) || badField(f));
    if (sample !== null && typeof sample === "object" && "status" in sample) return badField(value);
    if (value !== null && typeof value === "object" && !Array.isArray(value) && sample !== null && typeof sample === "object" && !Array.isArray(sample)) {
      const wrong = Object.entries(value).some(([k, f]) => sample[k] !== null && typeof sample[k] === "object" && "status" in sample[k] && badField(f, section === "care" && k === "weekly"));
      if (wrong) return true;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value) || sample === null || typeof sample !== "object" || Array.isArray(sample) || "status" in sample) return false;
    return Object.keys(value).some((k) => !(k in sample));
  });
}

const MAX_FIELDS = 200;
const validFields = (fields) => Array.isArray(fields) && fields.length <= MAX_FIELDS && fields.every((f) => f !== null && typeof f === "object" && Object.keys(f).length === 2 && /^extra\.x\d{1,3}$/.test(f.key) && typeof f.label === "string" && f.label.length <= MAX_HEADER && !CONTROL.test(f.label) && !looksLikeValue(f.label));

function checkPlanPayload(payload, allowed) {
  const extra = Object.keys(payload ?? {}).filter((k) => !allowed.includes(k));
  if (extra.length > 0) return ["決まった項目以外が入っています"];
  if (typeof payload?.plan !== "object" || payload.plan === null) return ["計画の形が正しくありません"];
  if (payload.plan.care?.weekly?.value?.unread) return ["読めなかった予定の文は送れません"];
  const text = JSON.stringify(payload);
  if (text.length > LIMIT) return ["内容が長すぎます"];
  if (Object.keys(payload.plan).some((k) => !PLAN_KEYS.has(k))) return ["計画に決まった項目以外が入っています"];
  if (hasUnknownKeys(payload.plan)) return ["計画に決まった項目以外が入っています"];
  if (hasBigNumber(payload.plan)) return ["番号らしいものが入っています"];
  const helpers = payload.plan.helpers ?? [];
  if (!Array.isArray(helpers) || helpers.some((h) => Object.keys(h ?? {}).some((k) => !HELPER_KEYS.has(k)))) return ["手伝う人の形が正しくありません"];
  if ("fields" in payload && !validFields(payload.fields)) return ["欄の一覧の形が正しくありません"];
  if ("blanks" in payload && !(Array.isArray(payload.blanks) && payload.blanks.length <= MAX_FIELDS && payload.blanks.every((b) => typeof b === "string" && b.length <= MAX_HEADER && !CONTROL.test(b) && !looksLikeValue(b)))) return ["空の列の一覧の形が正しくありません"];
  if ("gaps" in payload && payload.gaps !== null && !(Array.isArray(payload.gaps) && payload.gaps.every((g) => /^[月火水木金土日]$/.test(g)))) return ["曜日の形が正しくありません"];
  for (const value of strings(payload)) {
    const kind = personalKind(value);
    if (kind) return [`${kind}らしいものが入っています`];
  }
  return [];
}

export function validateScribePayload(p) {
  if (typeof p?.memo !== "string" || p.memo.trim() === "") return ["声メモが空です"];
  if (p.memo.length > MAX_MEMO) return ["声メモが長すぎます。分けて入れてください"];
  return checkPlanPayload(p, ["memo", "plan", "fields"]);
}
export const validateCheckPayload = (p) => checkPlanPayload(p, ["plan", "gaps", "blanks", "fields"]);
