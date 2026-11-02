// コードを書き換えたら、すぐ全部のテストを流す。落ちたら内容を Claude に返して直させる
import { spawnSync } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
let input = "";
for await (const chunk of process.stdin) input += chunk;
const file = JSON.parse(input || "{}").tool_input?.file_path;
if (!file) process.exit(0);

const path = relative(ROOT, resolve(file)).split(sep).join("/");
const watched = /^(src|public|test|samples|scripts)\//.test(path) || path === "server.mjs";
if (!watched || !/\.(m?js|json|csv)$/.test(path)) process.exit(0);

const run = spawnSync(process.execPath, ["--test", "--test-reporter=dot"], { cwd: ROOT, encoding: "utf-8", env: { ...process.env, ANTHROPIC_API_KEY: "" } });
if (run.status !== 0) {
  console.error(`テストが落ちています（${path} を変更したあと）\n${(run.stdout + run.stderr).slice(-3000)}`);
  process.exit(2);
}
