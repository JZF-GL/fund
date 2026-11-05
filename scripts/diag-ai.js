const https = require("https");
const fs = require("fs");

function getText(url) {
  return new Promise((res, rej) => {
    https
      .get(
        url,
        { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://gu.qq.com/" }, timeout: 15000 },
        (r) => {
          const b = [];
          r.on("data", (c) => b.push(c));
          r.on("end", () => res(Buffer.concat(b).toString("latin1")));
        }
      )
      .on("error", rej);
  });
}

(async () => {
  const j = await (await fetch("http://127.0.0.1:5173/api/holdings/live")).json();
  const b = j.byFund.ai;
  const store = JSON.parse(fs.readFileSync("data/holdings.json", "utf8"));
  const cur = store.sources["159819"];
  const q3codes = new Set(
    cur.holdings.filter((h) => h.weightFrom === "2026-09-30").map((h) => h.code)
  );

  let all = 0;
  let only3 = 0;
  let w3 = 0;
  let wStale = 0;
  let contribStale = 0;
  for (const s of b.stocks) {
    if (s.pct == null) continue;
    const part = (s.weight / 100) * s.pct;
    all += part;
    if (q3codes.has(s.code)) {
      only3 += part;
      w3 += s.weight;
    } else {
      wStale += s.weight;
      contribStale += part;
    }
  }

  const t = await getText("https://qt.gtimg.cn/q=sz159819");
  const m = t.match(/v_sz159819="([^"]+)"/);
  const p = m ? m[1].split("~") : [];
  console.log("ETF 159819 price=" + p[3] + " prev=" + p[4] + " pct=" + p[32] + "%");
  console.log("merged basket raw=" + all.toFixed(3) + "% x0.95=" + (all * 0.95).toFixed(3) + "%");
  console.log("Q3-only raw=" + only3.toFixed(3) + "% cover=" + w3.toFixed(2) + "% avg=" + (only3 / (w3 / 100)).toFixed(3) + "%");
  console.log("Q2-only(stale) weight=" + wStale.toFixed(2) + "% contrib=" + contribStale.toFixed(3) + "%");
})().catch((e) => console.error("ERR", e.message));
