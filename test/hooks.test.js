// Claude Code のフックが、止めるものを止めて、通すものを通すか
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const guard = fileURLToPath(new URL("../.claude/hooks/guard-command.mjs", import.meta.url));
const run = (command) => spawnSync(process.execPath, [guard], { input: JSON.stringify({ tool_input: { command } }), encoding: "utf-8" });

test("取り返しのつかないコマンドを止める", () => {
  for (const command of [
    "cat .env",
    "type D:\\hackathon\\hinan-hanashi\\.env",
    "Get-Content .env",
    "gh repo edit agakajin/hinan-hanashi --visibility public --accept-visibility-change-consequences",
    "git push --force origin main",
    "git commit --no-verify -m x",
    'echo "$ANTHROPIC_API_KEY"',
  ]) {
    const r = run(command);
    assert.equal(r.status, 2, command);
    assert.ok(r.stderr.length > 0, command);
  }
});

test("お金がかかる実行は人に聞く", () => {
  const r = run("node --env-file=.env scripts/try-claude.mjs --go");
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "ask");
});

test("ふだんのコマンドは通す", () => {
  for (const command of ["npm test", "git status", "git push origin main", "cat .env.example", "node --env-file=.env server.mjs", "node scripts/try-claude.mjs"]) {
    const r = run(command);
    assert.equal(r.status, 0, command);
    assert.equal(r.stdout, "", command);
  }
});
