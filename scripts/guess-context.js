#!/usr/bin/env node
/**
 * 汇总「猜次日涨跌」需要的本地数据，输出紧凑 JSON 供 AI 分析使用。
 * 依赖正在运行的 server.js（默认 http://127.0.0.1:5173）。
 *
 * 用法：node scripts/guess-context.js [baseUrl]
 */
const BASE = process.argv[2] || "http://127.0.0.1:5173";
const FUNDS = [
  { id: "ai", code: "012734", name: "易方达人工智能ETF联接C" },
  { id: "nev", code: "011513", name: "天弘中证新能源汽车指数C" },
];

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, {
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
  return res.json();
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function ma(points, n) {
  if (points.length < n) return null;
  const slice = points.slice(-n);
  return slice.reduce((a, b) => a + b.nav, 0) / n;
}

function sumPct(points, n) {
  const slice = points.slice(-n);
  const s = slice.reduce((a, b) => a + (Number(b.dailyPct) || 0), 0);
  return Number(s.toFixed(2));
}

function nextWeekday(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  do {
    d.setDate(d.getDate() + 1);
  } while (d.getDay() === 0 || d.getDay() === 6);
  return dayKey(d.getTime());
}

(async () => {
  const today = dayKey(Date.now());
  const out = { generatedAt: new Date().toISOString(), today, targetDate: nextWeekday(today), funds: [] };

  let status = null;
  try {
    status = await getJson("/api/status");
    out.server = {
      lastOk: status.collector && status.collector.lastOk,
      lastAt: status.collector && status.collector.lastAtLabel,
      inSession: status.collector && status.collector.inSession,
    };
  } catch (e) {
    out.server = { error: `服务未启动？${e.message}` };
  }

  let history = null;
  try {
    history = await getJson("/api/history");
  } catch {
    history = { funds: {} };
  }

  let daily = null;
  try {
    daily = await getJson("/api/daily-estimates");
  } catch {
    daily = { days: {} };
  }

  let live = null;
  try {
    live = await getJson("/api/holdings/live");
  } catch {
    live = null;
  }

  for (const f of FUNDS) {
    const pts = ((history.funds && history.funds[f.id] && history.funds[f.id].points) || []).filter(
      (p) => Number.isFinite(p.nav)
    );
    const last = pts[pts.length - 1] || null;
    const recent = pts.slice(-10).map((p) => ({
      date: dayKey(p.ts),
      nav: p.nav,
      pct: Number.isFinite(p.dailyPct) ? Number(p.dailyPct.toFixed(2)) : null,
    }));

    const m5 = last ? ma(pts, 5) : null;
    const m10 = last ? ma(pts, 10) : null;
    const m20 = last ? ma(pts, 20) : null;

    const estDay = daily.days && daily.days[today];
    const est = estDay && estDay.funds ? estDay.funds[f.id] : null;

    const block = live && live.byFund ? live.byFund[f.id] : null;
    const stocks = (block && block.stocks) || [];
    const upCount = stocks.filter((s) => s.pct > 0).length;
    const downCount = stocks.filter((s) => s.pct < 0).length;
    const top = stocks
      .slice()
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 8)
      .map((s) => ({ name: s.name, weight: s.weight, pct: s.pct }));

    out.funds.push({
      code: f.code,
      id: f.id,
      name: f.name,
      lastReal: last
        ? {
            date: dayKey(last.ts),
            nav: last.nav,
            pct: Number.isFinite(last.dailyPct) ? Number(last.dailyPct.toFixed(2)) : null,
          }
        : null,
      ma5: m5 != null ? Number(m5.toFixed(4)) : null,
      ma10: m10 != null ? Number(m10.toFixed(4)) : null,
      ma20: m20 != null ? Number(m20.toFixed(4)) : null,
      aboveMa5: last && m5 != null ? last.nav > m5 : null,
      aboveMa10: last && m10 != null ? last.nav > m10 : null,
      sum5: last ? sumPct(pts, 5) : null,
      sum10: last ? sumPct(pts, 10) : null,
      recent,
      todayEstimate: est
        ? {
            pct: est.pct,
            method: est.method,
            baseNav: est.baseNav,
            baseNavDate: est.baseNavDate,
            updatedAt: estDay.updatedAt,
          }
        : null,
      holdingsLive: block
        ? {
            ts: live.ts,
            coveredWeight: block.coveredWeight,
            contribPct: block.contribPct,
            up: upCount,
            down: downCount,
            top,
          }
        : null,
    });
  }

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
