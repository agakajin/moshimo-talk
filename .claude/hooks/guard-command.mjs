// コマンドを動かす前に見る。取り返しのつかないことと、お金がかかることを人の判断に戻す
let input = "";
for await (const chunk of process.stdin) input += chunk;
const command = String(JSON.parse(input || "{}").tool_input?.command ?? "");

const BLOCK = [
  [/\b(cat|type|more|less|head|tail|grep|rg|sed|awk|Get-Content|gc|Select-String)\b[^|;&]*(^|[\s\\/"'])\.env(?!\.example)\b/i, ".env の中身は読みません"],
  [/\bprintenv\b.*ANTHROPIC|\becho\b.*\$\{?(env:)?ANTHROPIC_API_KEY/i, "鍵を画面に出しません"],
  [/\bgh\s+repo\s+(edit|create)\b.*(--visibility[=\s]+public|--public)/i, "公開への切り替えはジンさんが決めます（11/7 の点検のあと）"],
  [/\bgit\s+push\b.*(--force|\s-f\b)/i, "履歴を上書きする push はしません"],
  [/\bgit\s+commit\b.*--no-verify/i, "秘密情報の検査を飛ばしません"],
];
const ASK = [
  [/try-claude\.mjs\b.*--go/, "本物の Claude を呼びます（有料）。実行してよいかジンさんに確認してください"],
];

for (const [pattern, reason] of BLOCK) {
  if (pattern.test(command)) {
    console.error(reason);
    process.exit(2);
  }
}
for (const [pattern, reason] of ASK) {
  if (pattern.test(command)) {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason } }));
    process.exit(0);
  }
}
