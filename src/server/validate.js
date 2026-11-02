// サーバーの入口で、記号以外が混ざっていないかを調べる。本物の値が届いたら Claude に渡さず止める
const SYMBOL = /^(?:空|(?:文字列|電話番号|郵便番号|住所|日付)\d+)$/;
const MAX_COLUMNS = 200;
const MAX_HEADER = 60;

export function validateColumnsPayload(payload) {
  const errors = [];
  const columns = payload?.columns;
  if (!Array.isArray(columns) || columns.length === 0 || columns.length > MAX_COLUMNS) {
    return ["列の一覧の形が正しくありません"];
  }
  const extraTop = Object.keys(payload).filter((k) => k !== "columns");
  if (extraTop.length > 0) errors.push("決まった項目以外が入っています");

  columns.forEach((c, i) => {
    const extra = Object.keys(c ?? {}).filter((k) => !["header", "withheld", "samples"].includes(k));
    if (extra.length > 0) errors.push(`${i + 1}列目：決まった項目以外が入っています`);
    if (typeof c?.header !== "string" || c.header.length === 0 || c.header.length > MAX_HEADER) {
      errors.push(`${i + 1}列目：見出しの形が正しくありません`);
    }
    if (!Array.isArray(c?.samples) || !c.samples.every((s) => typeof s === "string" && SYMBOL.test(s))) {
      errors.push(`${i + 1}列目：記号でない値が入っています`);
    }
    if (c?.withheld === true && c.samples?.length > 0) errors.push(`${i + 1}列目：送らない列に値が入っています`);
  });
  return errors;
}

const PHONE_LIKE = /\d[\d\-‐()\s]{7,}\d/;
const LIMIT = 8000;

function checkPlanPayload(payload, allowed) {
  const extra = Object.keys(payload ?? {}).filter((k) => !allowed.includes(k));
  if (extra.length > 0) return ["決まった項目以外が入っています"];
  if (typeof payload?.plan !== "object" || payload.plan === null) return ["計画の形が正しくありません"];
  if (payload.plan.care?.weekly?.value?.unread) return ["読めなかった予定の文は送れません"];
  const text = JSON.stringify(payload);
  if (text.length > LIMIT) return ["内容が長すぎます"];
  if (PHONE_LIKE.test(text)) return ["電話番号らしい数字が入っています"];
  return [];
}

export const validateScribePayload = (p) => (typeof p?.memo === "string" && p.memo.trim() !== "" ? checkPlanPayload(p, ["memo", "plan"]) : ["声メモが空です"]);
export const validateCheckPayload = (p) => checkPlanPayload(p, ["plan", "gaps"]);
