// コミット前に、鍵と架空でない連絡先が混ざっていないかを調べる
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const RULES = [
  ["Anthropic の鍵", /sk-ant-[A-Za-z0-9_-]{10,}/],
  ["GitHub の鍵", /\bgh[opsu]_[A-Za-z0-9]{20,}/],
  ["Google の鍵", /AIza[0-9A-Za-z_-]{30,}/],
  ["私有鍵", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["メールアドレス", /[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com)[A-Za-z0-9-]+\.[A-Za-z]{2,}/],
  ["実在しうる電話番号", /(?<![\d-])0[1-9]\d{0,3}-\d{1,4}-\d{4}(?![\d-])/],
];
// 通知の宛先の例など、誤検知を避けるファイルだけ外す
const SKIP = [/^LICENSE$/, /^scripts\/check-secrets\.mjs$/];

const staged = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACM"], { encoding: "utf-8" })
  .split("\n").filter(Boolean).filter((f) => !SKIP.some((re) => re.test(f)));

const problems = [];
for (const file of staged) {
  if (/(^|\/)\.env(\.|$)/.test(file) && !file.endsWith(".env.example")) problems.push(`${file}: .env はコミットしない`);
  let text;
  try { text = readFileSync(file, "utf-8"); } catch { continue; }
  for (const [label, re] of RULES) if (re.test(text)) problems.push(`${file}: ${label}らしき文字列`);
}

if (problems.length > 0) {
  console.error("コミットを止めました:\n" + problems.map((p) => "  " + p).join("\n"));
  process.exit(1);
}
