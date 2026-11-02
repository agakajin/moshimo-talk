// 本物のサーバーを立てて、外に置くときの決まりを確かめる
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isAuthorized, startupProblem } from "../src/server/auth.js";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
const PASSWORD = "test-only-password";
const basic = (p) => `Basic ${Buffer.from(`demo:${p}`).toString("base64")}`;

function run(env) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env, PORT: "0" } });
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
