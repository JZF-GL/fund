// 用近 12 个交易日寻找「持仓加权 + ETF 涨幅」的最佳混合比例
const https = require("https");
const fs = require("fs");

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

function pctOf(map, date, prev) {
  const a = map && map.get(date);
  const b = map && map.get(prev);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return ((a - b) / b) * 100;
}

(async () => {
  const store = JSON.parse(fs.readFileSync("data/holdings.json", "utf8"));
  const cur = store.sources["159819"];
  const codes = [...new Set(cur.holdings.map((h) => h.code))];
  const symOf = (c) => (c.startsWith("6") ? "sh" + c : "sz" + c);
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
  const rows = [];
  for (let i = 1; i < dates.length; i++) {
    const date = dates[i];
    const prev = dates[i - 1];
    const etfPct = pctOf(etf, date, prev);
    if (etfPct == null) continue;
    const real = realPts.find((p) => {
      const d = new Date(p.ts);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` === date;
    });
    if (!real) continue;

    let basket = 0;
    for (const h of cur.holdings) {
      const p = pctOf(klines[h.code], date, prev);
      if (p == null) continue;
      basket += (h.weight / 100) * p;
    }
    rows.push({ date, real: real.dailyPct, basket, etf: etfPct });
  }

  // 最优 scale（只用持仓）
  let xy = 0, xx = 0;
  for (const r of rows) {
    xy += r.basket * r.real;
    xx += r.basket * r.basket;
  }
  const scale = xy / xx;
  console.log(`持仓最优 scale = ${scale.toFixed(3)}（当前 0.95）`);

  console.log("\n混合比例  λ(ETF 权重)   平均绝对误差(pp)");
  let best = null;
  for (let lam = 0; lam <= 1.0001; lam += 0.1) {
    let e = 0;
    for (const r of rows) {
      const pred = (1 - lam) * r.basket * scale + lam * r.etf;
      e += Math.abs(pred - r.real);
    }
    const mae = e / rows.length;
    if (!best || mae < best.mae) best = { lam, mae };
    console.log(`           ${lam.toFixed(1)}          ${mae.toFixed(3)}`);
  }
  console.log(`\n最佳：λ=${best.lam.toFixed(1)}，MAE=${best.mae.toFixed(3)}pp（n=${rows.length}）`);

  console.log("\n逐日对比（scale=" + scale.toFixed(3) + "）");
  console.log("日期        真实%   持仓%   ETF%   混合50%");
  for (const r of rows) {
    const mix = 0.5 * r.basket * scale + 0.5 * r.etf;
    console.log(
      `${r.date}  ${r.real.toFixed(2).padStart(6)}  ${(r.basket * scale).toFixed(2).padStart(6)}  ${r.etf.toFixed(2).padStart(5)}  ${mix.toFixed(2).padStart(6)}`
    );
  }
})().catch((e) => console.error("ERR", e.message));
