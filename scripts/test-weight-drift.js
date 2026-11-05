// 对比三种持仓估值方式在 012734（AI 联接）上的误差
// A: 当前缓存权重（Q2 全量 + Q3 前27覆盖）
// B: 只用三季报 27 只，权重静态
// C: 三季报 27 只，权重按个股价差漂移到当日（残差用 ETF 涨幅补）
const https = require("https");
const fs = require("fs");

const SYMBOLS = {
  688256: "sz688256", 300502: "sz300502", 688008: "sz688008", 300308: "sz300308",
  688041: "sz688041", 002415: "sz002415", 603019: "sh603019", 300857: "sz300857",
  002281: "sz002281", 688521: "sz688521", 000938: "sz000938", 000977: "sz000977",
  300223: "sz300223", 603501: "sh603501", 002230: "sz002230", 600570: "sh600570",
  688111: "sh688111", 002236: "sz002236", 300454: "sz300454", 688036: "sh688036",
  002371: "sz002371", 300474: "sz300474", 688169: "sh688169", 002049: "sz002049",
  300496: "sz300496", 688188: "sh688188", 300661: "sz300661",
};

function getText(url) {
  return new Promise((res, rej) => {
    https
      .get(url, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://gu.qq.com/" }, timeout: 15000 }, (r) => {
        const b = [];
        r.on("data", (c) => b.push(c));
        r.on("end", () => res(Buffer.concat(b).toString("utf8")));
      })
      .on("error", rej);
  });
}

async function kline(symbol) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,2026-09-01,2026-11-04,80,qfq`;
  const j = JSON.parse(await getText(url));
  const d = j.data[symbol];
  const rows = (d && (d.qfqday || d.day)) || [];
  const out = new Map();
  for (const r of rows) out.set(r[0], Number(r[2]));
  return out;
}

function pctOf(map, date, prevDate) {
  const a = map.get(date);
  const b = map.get(prevDate);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return ((a - b) / b) * 100;
}

(async () => {
  const store = JSON.parse(fs.readFileSync("data/holdings.json", "utf8"));
  const cur = store.sources["159819"];
  const q3 = cur.holdings.filter((h) => h.weightFrom === "2026-09-30");
  const q3Sum = q3.reduce((a, b) => a + b.weight, 0);

  const codes = [...new Set([...q3.map((h) => h.code), ...cur.holdings.map((h) => h.code)])];
  const symOf = (code) => SYMBOLS[code] || (code.startsWith("6") ? "sh" + code : "sz" + code);
  const klines = {};
  await Promise.all(
    codes.map(async (c) => {
      try {
        klines[c] = await kline(symOf(c));
      } catch {
        klines[c] = new Map();
      }
    })
  );
  const etf = await kline("sz159819");

  const hist = await (await fetch("http://127.0.0.1:5173/api/history")).json();
  const realPts = hist.funds.ai.points.slice(-12);

  const dates = [...etf.keys()].sort().filter((d) => d >= "2026-10-09");

  console.log("日期        真实%   ETF%   A静态%   B仅Q3%   C漂移%");
  let errA = 0, errB = 0, errC = 0, n = 0;
  for (let i = 1; i < dates.length; i++) {
    const date = dates[i];
    const prev = dates[i - 1];
    const etfPct = pctOf(etf, date, prev);
    if (etfPct == null) continue;

    const real = realPts.find((p) => {
      const dt = new Date(p.ts);
      const k = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
      return k === date;
    });
    if (!real) continue;

    // A 静态（全部合并权重）
    let a = 0;
    for (const h of cur.holdings) {
      const p = pctOf(klines[h.code], date, prev);
      if (p == null) continue;
      a += (h.weight / 100) * p;
    }
    // B 仅 Q3 静态 + 残差按已覆盖均值
    let bCover = 0, bSum = 0;
    for (const h of q3) {
      const p = pctOf(klines[h.code], date, prev);
      if (p == null) continue;
      bSum += (h.weight / 100) * p;
      bCover += h.weight;
    }
    const bAvg = bSum / (bCover / 100);
    const b = bSum + (1 - bCover / 100) * bAvg;

    // C 漂移：权重 * 价格相对 9/30 的变化，残差按 ETF 涨幅
    let cDrift = 0, cSumW = 0;
    for (const h of q3) {
      const k = klines[h.code];
      const base = k.get("2026-09-30");
      const now = k.get(date);
      const p = pctOf(k, date, prev);
      if (!Number.isFinite(base) || !Number.isFinite(now) || p == null) continue;
      const w = h.weight * (now / base);
      cDrift += (w / 100) * p;
      cSumW += w;
    }
    const resid = Math.max(0, 1 - cSumW / 100);
    const c = (cDrift + resid * etfPct) * 0.95;

    const A = a * 0.95;
    console.log(
      `${date}  ${real.dailyPct.toFixed(2).padStart(6)}  ${etfPct.toFixed(2).padStart(5)}  ${A.toFixed(2).padStart(7)}  ${b.toFixed(2).padStart(7)}  ${c.toFixed(2).padStart(6)}`
    );
    errA += Math.abs(A - real.dailyPct);
    errB += Math.abs(b - real.dailyPct);
    errC += Math.abs(c - real.dailyPct);
    n++;
  }
  if (n) {
    console.log(`\n平均绝对误差(pp): A静态=${(errA / n).toFixed(3)}  B仅Q3=${(errB / n).toFixed(3)}  C漂移=${(errC / n).toFixed(3)}  n=${n}`);
  }
})().catch((e) => console.error("ERR", e.message));
