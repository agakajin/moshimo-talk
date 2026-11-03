// もう片方の CSV（個別避難計画書）の値を計画に入れる。すべて手元で動かし、Claude には見出ししか送らない
import { expand } from "./format.js";
import { field, setIdentity } from "./plan.js";
import { looksLikeValue } from "./mask.js";
import { personalKind } from "./redact.js";

const getAt = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);
const compact = (v) => String(v ?? "").normalize("NFKC").replace(/\s/g, "");
const isIdentity = (target) => target.startsWith("self.") || target.startsWith("emergency.");

// 別の人の値を混ぜないよう、名前が同じで生年月日が食い違わない行だけを本人の行とする。1行に決まらなければ人が選ぶ
export function findPersonRow({ headers, rows }, targets, identity) {
  const column = (target) => headers.findIndex((h) => targets[h] === target);
  const nameAt = column("self.name");
  const name = identity["self.name"];
  if (nameAt < 0 || !name) return null;
  const birthAt = column("self.birth");
  const hits = rows.map((row, i) => [row, i]).filter(([row]) => {
    if (compact(row[nameAt]) !== compact(name) || !compact(name)) return false;
    const birth = {};
    if (birthAt < 0 || !identity["self.birth"] || !setIdentity(birth, "self.birth", row[birthAt] ?? "")) return true;
    return birth["self.birth"] === identity["self.birth"];
  });
  return hits.length === 1 ? hits[0][1] : null;
}

// 書き出したときの印は値ではないので、読み戻さない
function cleanValue(raw, blankValue) {
  const text = String(raw ?? "").trim().replace(/^'(?=[=+\-@])/, "");
  return text === "" || text === blankValue || text.includes("同意待ち") ? "" : text;
}

// 続柄は Claude に呼び名として送る。名前や番号らしければ使わない
const safeAlias = (relation, number) => (relation && relation.length <= 10 && !looksLikeValue(relation) && !personalKind(relation) ? relation : `手伝う人${number}`);

// 空の欄は埋め、同じ値はそのまま、違う値は人が選ぶために返す。話で聞く前の値なので source は csv のまま
export function mergeOutputRow(imported, { headers, row, targets, blankValue = "未決定" }) {
  const result = { filled: [], conflicts: [], unread: [], helpers: [] };
  imported.fromOutput ??= [];
  imported.leftovers ??= [];
  const helpers = {};
  headers.forEach((header, i) => {
    const target = targets[header];
    const value = cleanValue(row[i], blankValue);
    if (!target || !value || target === "none" || target === "meta.createdOn") return;
    if (target === "meta.serial") {
      imported.serial = value;
      return;
    }
    const helper = /^helper([12])\.(name|relation|phone)$/.exec(target);
    if (helper) {
      (helpers[helper[1]] ??= {})[helper[2]] = value;
      return;
    }
    if (isIdentity(target)) {
      const parsed = {};
      if (!setIdentity(parsed, target, value)) {
        result.unread.push(header);
        return;
      }
      const current = imported.identity[target];
      if (!current) {
        imported.identity[target] = parsed[target];
        result.filled.push({ label: header, value: parsed[target] });
      } else if (current !== parsed[target]) {
        result.conflicts.push({ key: target, label: header, current, incoming: parsed[target], local: true });
      }
      return;
    }
    // 1列にまとめて書かれた文は分けられない。下の欄がすべて空のときだけ入れ、ほかは手元に残して見せる
    const roomy = { "considerations.all": ["considerations.items", ["care.mobility", "care.stairs", "care.hearing", "considerations.items"]], "hazards.all": ["hazards.items", ["hazards.items", "home.hazardNote"]] }[target];
    if (roomy && roomy[1].every((p) => getAt(imported.plan, p)?.status !== "filled")) {
      fillField(imported, roomy[0], header, value, result);
      return;
    }
    if (roomy || target === "evacuation.summary" || target === "evacuation.minutes") {
      imported.leftovers.push({ label: header, value });
      return;
    }
    fillField(imported, target, header, value, result);
  });
  for (const number of Object.keys(helpers).sort()) addHelper(imported, helpers[number], number, result);
  return result;
}

function fillField(imported, path, label, value, result) {
  const f = getAt(imported.plan, path);
  if (!f || typeof f !== "object" || !("status" in f)) return;
  if (f.status !== "filled") {
    Object.assign(f, { ...field(), value, status: "filled", source: "csv" });
    imported.fromOutput.push(path);
    result.filled.push({ label, value });
  } else if (compact(f.value) !== compact(value)) {
    result.conflicts.push({ key: path, label, current: f.value, incoming: value, local: false });
  }
}

// 前の計画書の名前を手元に入れる。今も頼めるかは分からないので、「頼めた」の印は付けない
function addHelper(imported, { name, relation, phone }, number, result) {
  if (!name && !relation) return;
  const alias = safeAlias(relation, number);
  const parsed = {};
  const person = { name: name ?? "", alias, phone: phone && setIdentity(parsed, "self.phone", phone) ? parsed["self.phone"] : "" };
  imported.people.push(person);
  if (!imported.plan.helpers.some((h) => h.alias === alias)) imported.plan.helpers.push({ alias, awayWeekdayDaytime: false, asked: false, memoId: null });
  result.helpers.push(alias);
}

// 表記が違うだけの生年月日や電話番号を、違う値と見ない
function sameValue(target, a, b) {
  if (!isIdentity(target)) return compact(a) === compact(b);
  const [left, right] = [{}, {}];
  return setIdentity(left, target, a) && setIdentity(right, target, b) ? left[target] === right[target] : compact(a) === compact(b);
}

// 渡す様式の列ごとに、値がどこから来るかを求める。input はケアプラン、planRow は計画書の選んだ行
export function describeFlows({ columns, input = null, plan = null, planHeaders = [], planRow = null, blankValue = "未決定" }) {
  const rows = columns.map(({ header, target }) => {
    if (target === "unknown") return { header, target, kind: "unknown", from: [] };
    if (target === "none") return { header, target, kind: "none", from: [] };
    if (target === "meta.createdOn") return { header, target, kind: "auto", from: [] };
    const planAt = planHeaders.indexOf(header);
    const incoming = planRow && planAt >= 0 ? cleanValue(planRow[planAt], blankValue) : "";
    const paths = expand(target);
    const from = (input?.headers ?? []).map((h, i) => ({ header: h, value: String(input.row[i] ?? "").trim(), target: input.mapping[h] }))
      .filter((c) => c.value && (paths.includes(c.target) || (target === "new" && c.header === header && c.target?.startsWith("extra."))))
      .map(({ header: h, value }) => ({ header: h, value }));
    // 訪問の途中で聞いた値は、もとの CSV より新しい
    const talked = plan ? paths.map((p) => getAt(plan, p)).filter((f) => f?.status === "filled" && ["voice", "human"].includes(f.source)).map((f) => String(f.value)) : [];
    if (talked.length > 0) return { header, target, kind: "talk", from: [], talked };
    if (target === "meta.serial" && !incoming) return { header, target, kind: "auto", from: [] };
    if (from.length > 0) {
      const differs = incoming && from.length === 1 && !sameValue(target, from[0].value, incoming) ? incoming : null;
      return { header, target, kind: "care", from, differs };
    }
    if (incoming) return { header, target, kind: "plan", from: [{ header, value: incoming }] };
    return { header, target, kind: isIdentity(target) ? "hand" : "talk", from: [] };
  });
  const delivered = new Set(columns.flatMap(({ target }) => expand(target)));
  const unused = (input?.headers ?? []).filter((h, i) => String(input.row[i] ?? "").trim() && input.mapping[h] && !delivered.has(input.mapping[h]) && !columns.some((c) => c.target === "new" && c.header === h));
  return { rows, unused };
}

// 違っていた欄で、どちらの値を使うかを決める
export function chooseConflict(imported, { key, current, incoming, local }, useIncoming) {
  const value = useIncoming ? incoming : current;
  if (local) {
    imported.identity[key] = value;
    return;
  }
  getAt(imported.plan, key).value = value;
  imported.fromOutput = imported.fromOutput.filter((p) => p !== key);
  if (useIncoming) imported.fromOutput.push(key);
}
