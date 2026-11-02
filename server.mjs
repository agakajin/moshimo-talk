// 小さなサーバー。画面を配り、Claude への窓口になる。本物の値は受け取らない
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateColumnsPayload } from "./src/server/validate.js";
import { mockReadColumns } from "./src/server/mock-reader.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT ?? 5177);
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
  const file = normalize(join(mount[1], decodeURIComponent(path.slice(mount[0].length))));
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

async function handleReadColumns(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { errors: ["内容を読めませんでした"] });
  }
  const errors = validateColumnsPayload(payload);
  if (errors.length > 0) return sendJson(res, 422, { errors });
  // 中身はログに残さない
  return sendJson(res, 200, { mode: "mock", results: mockReadColumns(payload) });
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (req.method === "POST" && pathname === "/api/read-columns") return handleReadColumns(req, res);
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

// このパソコンの中からだけ開ける
server.listen(PORT, "127.0.0.1", () => console.log(`http://localhost:${PORT}`));
