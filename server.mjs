// 小さなサーバー。画面を配り、Claude への窓口になる。本物の値は受け取らない
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCheckPayload, validateColumnsPayload, validateScribePayload } from "./src/server/validate.js";
import { mockReadColumns } from "./src/server/mock-reader.js";
import { mockCheck, mockScribe } from "./src/server/mock-talk.js";
import { ClaudeError, createClaude, DEFAULT_MODEL } from "./src/server/claude.js";
import { isAuthorized, SECURITY_HEADERS, startupProblem } from "./src/server/auth.js";
import { createLimiter } from "./src/server/limits.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT ?? 5177);
const HOST = process.env.HOST ?? "127.0.0.1";
const PASSWORD = process.env.APP_PASSWORD ?? "";
const PUBLIC_DEMO = process.env.PUBLIC_DEMO === "1";
const limiter = createLimiter({
  perMinute: Number(process.env.LIMIT_PER_MINUTE ?? 40),
  perDay: Number(process.env.LIMIT_PER_DAY ?? 500),
});

const problem = startupProblem({ host: HOST, password: PASSWORD });
if (problem) {
  console.error(problem);
  process.exit(1);
}
const MAX_BODY = 64 * 1024;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".csv": "text/csv" };

// 配ってよい場所だけを並べる
const MOUNTS = [
  ["/core/", join(ROOT, "src", "core")],
  ["/samples/", join(ROOT, "samples")],
  ["/", join(ROOT, "public")],
];

function resolveStatic(pathname) {
  const path = pathname === "/" ? "/index.html" : pathname;
  const mount = MOUNTS.find(([prefix]) => path.startsWith(prefix));
  if (!mount) return null;
  let relative;
  try {
    relative = decodeURIComponent(path.slice(mount[0].length));
  } catch {
    return null;
  }
  const file = normalize(join(mount[1], relative));
  return file.startsWith(mount[1] + sep) ? file : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

const sendJson = (res, status, data) => {
  res.writeHead(status, { "Content-Type": TYPES[".json"], "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
};

const VILLAGE = JSON.parse(await readFile(join(ROOT, "samples", "hakka-village.config.json"), "utf-8"));

// 鍵が無ければ仮の答えで動く。鍵があるのに失敗したときは、仮の答えに逃げず失敗と返す
const MOCK = {
  readColumns: (p) => ({ results: mockReadColumns(p) }),
  scribe: (p) => ({ updates: mockScribe(p.memo) }),
  check: (p) => ({
    findings: mockCheck({ plan: p.plan, gaps: p.gaps, targetMinutes: VILLAGE.evacuationTargetMinutes, yardstick: VILLAGE.yardsticks[0] }),
  }),
};

async function connectClaude() {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return createClaude({
    client: new Anthropic({ timeout: 60_000, maxRetries: 1 }),
    village: VILLAGE,
    model: process.env.CLAUDE_MODEL || DEFAULT_MODEL,
    // 量と時間だけ残す。中身は残さない
    onUsage: ({ role, model, usage, ms }) => console.log(role, model, `in=${usage.input_tokens}`, `out=${usage.output_tokens}`, `${ms}ms`),
  });
}

const MODE = process.env.ANTHROPIC_API_KEY ? "claude" : "mock";
const ENGINE = MODE === "claude" ? await connectClaude() : MOCK;

const API = {
  "/api/read-columns": { validate: validateColumnsPayload, run: (p) => ENGINE.readColumns(p) },
  "/api/scribe": { validate: validateScribePayload, run: (p) => ENGINE.scribe(p) },
  "/api/check": { validate: validateCheckPayload, run: (p) => ENGINE.check(p) },
};

async function handleApi(req, res, route) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { errors: ["内容を読めませんでした"] });
  }
  const errors = route.validate(payload);
  if (errors.length > 0) return sendJson(res, 422, { errors });
  try {
    return sendJson(res, 200, { mode: MODE, ...(await route.run(payload)) });
  } catch (e) {
    if (e instanceof ClaudeError) return sendJson(res, e.status, { errors: [e.message] });
    // 中身はログに残さない
    console.error("処理に失敗しました", e.name);
    return sendJson(res, 500, { errors: ["処理に失敗しました"] });
  }
}

const server = createServer(async (req, res) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  let pathname;
  try {
    ({ pathname } = new URL(req.url, "http://localhost"));
  } catch {
    return sendJson(res, 400, { errors: ["使えない操作です"] });
  }
  if (req.method === "GET" && pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }
  if (!isAuthorized(req.headers.authorization, PASSWORD)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="demo", charset="UTF-8"', "Content-Type": "text/plain; charset=utf-8" });
    return res.end("パスワードが必要です");
  }
  if (req.method === "GET" && pathname === "/api/config") return sendJson(res, 200, { publicDemo: PUBLIC_DEMO });
  if (req.method === "POST" && API[pathname]) {
    // 手前の値は名乗り放題なので、置き場のプロキシが最後に足した値を使う
    const client = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress).split(",").at(-1).trim();
    const limit = limiter.check(client);
    if (!limit.ok) return sendJson(res, 429, { errors: [limit.reason] });
    return handleApi(req, res, API[pathname]);
  }
  if (req.method !== "GET") return sendJson(res, 405, { errors: ["使えない操作です"] });
  const file = resolveStatic(pathname);
  if (!file) return sendJson(res, 404, { errors: ["見つかりません"] });
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  } catch {
    sendJson(res, 404, { errors: ["見つかりません"] });
  }
});

// 何も指定しなければ、このパソコンの中からだけ開ける
server.listen(PORT, HOST, () => console.log(`http://localhost:${server.address().port}`));
