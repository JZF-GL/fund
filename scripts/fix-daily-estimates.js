// 修正历史 daily-estimates 的基准净值：用真实前一交易日净值重算 estNav
const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.resolve(__dirname, "..");
const FILE = path.join(ROOT, "data", "daily-estimates.json");
const CODES = { ai: "012734", nev: "011513" };

function getText(url) {
  return new Promise((res, rej) => {
    https
      .get(
        url,
        {
          headers: { "User-Agent": "Mozilla/5.0", Referer: "https://fund.eastmoney.com/" },
          timeout: 20000,
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

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

(async () => {
  const store = JSON.parse(
    fs.readFileSync(FILE, "utf8").replace(/^\uFEFF/, "")
  );
  const realByFund = {};

  for (const [id, code] of Object.entries(CODES)) {
    const body = await getText(`https://fund.eastmoney.com/pingzhongdata/${code}.js`);
    const m = body.match(/Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
    const arr = JSON.parse(m[1]);
    const map = new Map();
    for (const it of arr) {
      if (Number.isFinite(it.x) && Number.isFinite(it.y)) map.set(dayKey(it.x), it.y);
    }
    realByFund[id] = map;
  }

  let fixed = 0;
  for (const [date, day] of Object.entries(store.days || {})) {
    if (!day || !day.funds) continue;
    for (const [id, f] of Object.entries(day.funds)) {
      const map = realByFund[id];
      if (!map || !f || !Number.isFinite(f.pct)) continue;
      const keys = [...map.keys()].filter((k) => k < date).sort();
      const prevDate = keys[keys.length - 1];
      if (!prevDate) continue;
      const baseNav = map.get(prevDate);
      f.baseNav = baseNav;
      f.baseNavDate = prevDate;
      f.estNav = Number((baseNav * (1 + f.pct / 100)).toFixed(4));
      fixed++;
    }
  }

  store.updatedAt = Date.now();
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, FILE);
  console.log(`修正 ${fixed} 条历史估值记录`);
  console.log(`文件：${path.relative(ROOT, FILE)}`);
})().catch((e) => {
  console.error("ERR", e.message || e);
  process.exit(1);
});
