// 本物のサーバーを立てて、外に置くときの決まりを確かめる
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { isAuthorized, startupProblem } from "../src/server/auth.js";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
const PASSWORD = "test-only-password";
const basic = (p) => `Basic ${Buffer.from(`demo:${p}`).toString("base64")}`;

function run(env) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ANTHROPIC_API_KEY: "", ...env, PORT: "0" } });
  const ready = new Promise((resolve, reject) => {
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    child.stdout.on("data", (d) => {
      const m = /localhost:(\d+)/.exec(String(d));
      if (m) resolve(Number(m[1]));
    });
    child.on("exit", (code) => reject(Object.assign(new Error(err), { code })));
  });
  return { child, ready };
}

test("外から開ける設定は、十分なパスワードがないと起動しない", async () => {
  for (const env of [{ HOST: "0.0.0.0", APP_PASSWORD: "" }, { HOST: "0.0.0.0", APP_PASSWORD: "short" }]) {
    const { ready } = run(env);
    await assert.rejects(ready, (e) => e.code === 1 && e.message.includes("APP_PASSWORD"));
  }
  assert.equal(startupProblem({ host: "127.0.0.1", password: "" }), null);
});

test("パスワードの照合", () => {
  assert.equal(isAuthorized(basic(PASSWORD), PASSWORD), true);
  assert.equal(isAuthorized(basic("wrong"), PASSWORD), false);
  assert.equal(isAuthorized(undefined, PASSWORD), false);
  assert.equal(isAuthorized("Bearer x", PASSWORD), false);
  assert.equal(isAuthorized(basic(`${PASSWORD}:x`), `${PASSWORD}:x`), true);
});

test("パスワードなしでは画面もデータも API も開けない。死活確認だけ開く", async (t) => {
  const { child, ready } = run({ HOST: "127.0.0.1", APP_PASSWORD: PASSWORD });
  t.after(() => child.kill());
  const base = `http://127.0.0.1:${await ready}`;
  const auth = { Authorization: basic(PASSWORD) };

  for (const path of ["/", "/app.js", "/core/plan.js", "/samples/keahakka_okano.csv"]) {
    assert.equal((await fetch(base + path)).status, 401, path);
  }
  const api = await fetch(`${base}/api/check`, { method: "POST", body: "{}" });
  assert.equal(api.status, 401);
  assert.match(api.headers.get("www-authenticate"), /^Basic/);

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), "ok");

  const page = await fetch(`${base}/`, { headers: auth });
  assert.equal(page.status, 200);
  assert.match(page.headers.get("x-robots-tag"), /noindex/);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(await page.text(), /架空データ専用/);

  for (const path of ["/../server.mjs", "/core/../../server.mjs", "/%2e%2e/server.mjs", "/.env", "/package.json", "/src/server/auth.js"]) {
    assert.equal((await fetch(base + path, { headers: auth })).status, 404, path);
  }
  const rejected = await fetch(`${base}/api/read-columns`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ columns: [{ header: "氏名", withheld: false, samples: ["岡野 ハル"] }] }),
  });
  assert.equal(rejected.status, 422);
});

test("公開デモの設定と、回数の上限が効く", async (t) => {
  const { child, ready } = run({ HOST: "127.0.0.1", APP_PASSWORD: "", PUBLIC_DEMO: "1", LIMIT_PER_MINUTE: "1" });
  t.after(() => child.kill());
  const base = `http://127.0.0.1:${await ready}`;
  assert.deepEqual(await (await fetch(`${base}/api/config`)).json(), { publicDemo: true });
  const post = () => fetch(`${base}/api/check`, { method: "POST", body: JSON.stringify({ plan: {}, gaps: null }) });
  const first = await post();
  assert.equal(first.status, 500, "形のおかしい計画でもサーバーは落ちない");
  assert.deepEqual(await first.json(), { errors: ["処理に失敗しました"] });
  assert.equal((await post()).status, 429);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

// 本物の部品（SDK）を通し、向こう側だけ偽物にする
function fakeAnthropic(reply) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      const { status, json } = reply();
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })));
}
const message = (answer) => ({
  id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
  content: [{ type: "thinking", thinking: "", signature: "x" }, { type: "text", text: JSON.stringify(answer) }],
});
const COLUMNS = { columns: [{ header: "氏名", withheld: false, samples: ["文字列1"] }] };
const postColumns = (base) => fetch(`${base}/api/read-columns`, { method: "POST", body: JSON.stringify(COLUMNS) });

test("鍵があれば部品を通して Claude を呼び、mode で分かる", async (t) => {
  const api = await fakeAnthropic(() => ({ status: 200, json: message({ results: [{ header: "氏名", target: "self.name", confidence: "high" }] }) }));
  t.after(() => api.server.close());
  const { child, ready } = run({ HOST: "127.0.0.1", APP_PASSWORD: "", ANTHROPIC_API_KEY: "test-only-key", ANTHROPIC_BASE_URL: api.url });
  t.after(() => child.kill());
  const res = await postColumns(`http://127.0.0.1:${await ready}`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.mode, "claude");
  assert.deepEqual(data.results, [{ header: "氏名", target: "self.name", confidence: "high" }]);

  const [sent] = api.requests;
  assert.match(sent.url, /^\/v1\/messages/);
  assert.equal(sent.headers.authorization, "Bearer test-only-key");
  assert.match(sent.headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
  assert.equal(sent.body.fallbacks, "default");
  assert.ok(!("betas" in sent.body), "betas は見出しで送る");
  assert.equal(sent.body.model, "claude-opus-5-5");
  assert.equal(sent.body.output_config.format.type, "json_schema");
});

test("Claude が失敗したら、仮の答えに逃げず失敗と返す", async (t) => {
  const api = await fakeAnthropic(() => ({ status: 400, json: { type: "error", error: { type: "invalid_request_error", message: "秘密の文" } } }));
  t.after(() => api.server.close());
  const { child, ready } = run({ HOST: "127.0.0.1", APP_PASSWORD: "", ANTHROPIC_API_KEY: "test-only-key", ANTHROPIC_BASE_URL: api.url });
  t.after(() => child.kill());
  const res = await postColumns(`http://127.0.0.1:${await ready}`);
  assert.equal(res.status, 502);
  const data = await res.json();
  assert.deepEqual(data, { errors: ["Claude につながりませんでした"] });
});

test("鍵が無ければ仮の答えと分かる", async (t) => {
  const { child, ready } = run({ HOST: "127.0.0.1", APP_PASSWORD: "" });
  t.after(() => child.kill());
  const res = await postColumns(`http://127.0.0.1:${await ready}`);
  assert.equal((await res.json()).mode, "mock");
});

test("公開デモでは、サーバーでもサンプル以外の列を断り、長い声メモも断る", async (t) => {
  const { child, ready } = run({ HOST: "127.0.0.1", APP_PASSWORD: "", PUBLIC_DEMO: "1" });
  t.after(() => child.kill());
  const base = `http://127.0.0.1:${await ready}`;
  const send = (columns) => fetch(`${base}/api/read-columns`, { method: "POST", body: JSON.stringify({ columns }) });
  assert.equal((await send([{ header: "利用者名", withheld: false, samples: ["文字列1"] }])).status, 200);
  assert.equal((await send([{ header: "本物の台帳の列", withheld: false, samples: ["文字列1"] }])).status, 422);
  const long = await fetch(`${base}/api/scribe`, { method: "POST", body: JSON.stringify({ memo: "あ".repeat(1001), plan: {} }) });
  assert.equal(long.status, 422);
});

test("1人で1日の上限を使い切ると止まるが、ほかの人は使える", async (t) => {
  const { createLimiter } = await import("../src/server/limits.js");
  const limiter = createLimiter({ perMinute: 100, perDay: 100, perClientDay: 2, now: () => 0 });
  assert.equal(limiter.check("a").ok, true);
  assert.equal(limiter.check("a").ok, true);
  assert.equal(limiter.check("a").ok, false);
  assert.equal(limiter.check("b").ok, true);
});
