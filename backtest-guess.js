// 回测猜次日涨跌策略（猜收盘 vs 收盘，方向准确率）
const https = require("https");

function get(url) {
  return new Promise((res, rej) => {
    https
      .get(
        url,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            Referer: "https://fund.eastmoney.com/",
          },
          timeout: 15000,
        },
        (r) => {
          const b = [];
          r.on("data", (c) => b.push(c));
          r.on("end", () => res(Buffer.concat(b).toString("utf8")));
        }
      )
      .on("error", rej);
  });
}

async function fetchNavs(code) {
  const body = await get(
    `https://fund.eastmoney.com/pingzhongdata/${code}.js`
  );
  const m = body.match(/Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
  const arr = JSON.parse(m[1]);
  return arr
    .filter((it) => it && Number.isFinite(it.x) && Number.isFinite(it.y))
    .map((it) => ({ ts: it.x, nav: it.y, pct: it.equityReturn }));
}

function ma(nav, i, n) {
  if (i < n - 1) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += nav[k].nav;
  return s / n;
}

// 策略：返回 nextDay 的猜测方向 +1 / -1 / 0(猜平)
const strategies = {
  // A 动量延续：昨日涨猜涨
  A: (nav, i) => (nav[i].pct > 0 ? 1 : nav[i].pct < 0 ? -1 : 0),
  // B 均线趋势：收盘在 5/10 日均线上方猜涨（两线都满足才猜）
  B: (nav, i) => {
    const m5 = ma(nav, i, 5);
    const m10 = ma(nav, i, 10);
    if (m5 == null || m10 == null) return 0;
    if (nav[i].nav > m5 && nav[i].nav > m10) return 1;
    if (nav[i].nav < m5 && nav[i].nav < m10) return -1;
    return 0;
  },
  // C 动量+均线投票
  C: (nav, i) => {
    const m5 = ma(nav, i, 5);
    const m10 = ma(nav, i, 10);
    if (m5 == null || m10 == null) return 0;
    let score = 0;
    score += nav[i].pct > 0 ? 1 : nav[i].pct < 0 ? -1 : 0;
    score += nav[i].nav > m5 ? 1 : nav[i].nav < m5 ? -1 : 0;
    score += nav[i].nav > m10 ? 1 : nav[i].nav < m10 ? -1 : 0;
    return score > 0 ? 1 : score < 0 ? -1 : 0;
  },
};

function backtest(navs, fn) {
  let total = 0,
    guess = 0,
    right = 0,
    flat = 0;
  let streak = 0,
    bestStreak = 0,
    worstStreak = 0,
    cur = 0;
  const recent = [];
  for (let i = 0; i < navs.length - 1; i++) {
    const dir = fn(navs, i);
    const actual = navs[i + 1].pct > 0 ? 1 : navs[i + 1].pct < 0 ? -1 : 0;
    if (dir === 0) {
      flat++;
      continue;
    }
    total++;
    const ok = dir === actual;
    recent.push(ok ? 1 : 0);
    if (recent.length > 60) recent.shift();
    if (ok) {
      right++;
      cur++;
      if (cur > bestStreak) bestStreak = cur;
    } else {
      if (cur < worstStreak) worstStreak = cur;
      cur = 0;
    }
  }
  guess = total;
  const acc = guess ? (right / guess) * 100 : 0;
  const recentAcc = recent.length
    ? (recent.reduce((a, b) => a + b, 0) / recent.length) * 100
    : 0;
  return { guess, right, acc: acc.toFixed(2), flat, recentAcc: recentAcc.toFixed(2), bestStreak, worstStreak };
}

(async () => {
  for (const code of ["012734", "011513"]) {
    const navs = await fetchNavs(code);
    console.log(`\n=== ${code}  ${navs.length}个交易日 (${new Date(navs[0].ts).toISOString().slice(0,10)} ~ ${new Date(navs[navs.length-1].ts).toISOString().slice(0,10)}) ===`);
    for (const [name, fn] of Object.entries(strategies)) {
      const r = backtest(navs, fn);
      console.log(
        `策略${name}: 有方向${r.guess}次 对${r.right} 准确率${r.acc}% 近60日${r.recentAcc}% 无方向${r.flat} 连对${r.bestStreak} 连错${-r.worstStreak}`
      );
    }
    // 基准：全猜涨
    const up = backtest(navs, () => 1);
    console.log(`基准(全猜涨): 准确率${up.acc}%`);
  }
})().catch(console.error);
