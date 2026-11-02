// 外に置くときの合言葉。パスワードは環境変数からだけ読み、コードにもログにも残さない
import { createHash, timingSafeEqual } from "node:crypto";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const MIN_PASSWORD = 12;

const digest = (s) => createHash("sha256").update(s).digest();

export function startupProblem({ host, password }) {
  if (LOOPBACK.has(host)) return null;
  if (!password) return "外から開ける設定には APP_PASSWORD が必要です";
  if (password.length < MIN_PASSWORD) return `APP_PASSWORD は${MIN_PASSWORD}文字以上にしてください`;
  return null;
}

// 利用者名は問わない。パスワードだけを見る
export function isAuthorized(header, password) {
  if (!password) return true;
  const match = /^Basic\s+(.+)$/i.exec(header ?? "");
  if (!match) return false;
  const decoded = Buffer.from(match[1], "base64").toString("utf-8");
  const given = decoded.slice(decoded.indexOf(":") + 1);
  return timingSafeEqual(digest(given), digest(password));
}

export const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
};
