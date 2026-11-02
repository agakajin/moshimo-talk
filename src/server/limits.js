// 費用が暴走しないよう、接続元ごとの回数と1日の総数を数える。サーバーを再起動すると数え直す
export function createLimiter({ perMinute = 40, perDay = 3000, perClientDay = Infinity, now = () => Date.now() } = {}) {
  const hits = new Map();
  const clientDay = new Map();
  let day = "";
  let dayCount = 0;
  return {
    check(key) {
      const t = now();
      const today = new Date(t).toISOString().slice(0, 10);
      if (today !== day) { day = today; dayCount = 0; hits.clear(); clientDay.clear(); }
      if (dayCount >= perDay) return { ok: false, reason: "本日の上限に達しました。また明日お試しください" };
      // 1人で全部使い切らないようにする
      if ((clientDay.get(key) ?? 0) >= perClientDay) return { ok: false, reason: "本日の上限に達しました。また明日お試しください" };
      const recent = (hits.get(key) ?? []).filter((x) => t - x < 60_000);
      if (recent.length >= perMinute) return { ok: false, reason: "少し時間をおいてお試しください" };
      recent.push(t);
      hits.set(key, recent);
      clientDay.set(key, (clientDay.get(key) ?? 0) + 1);
      dayCount += 1;
      return { ok: true };
    },
  };
}
