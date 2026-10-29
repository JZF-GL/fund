const fs = require("fs");
const path = require("path");

const HOLDINGS_TTL_MS = 12 * 60 * 60 * 1000;
// 权重低于此阈值（%）的持仓直接丢弃，不参与展示与加权
const MIN_WEIGHT_PCT = 0.01;

function toTencentSymbol(code) {
  // 北交所：920 段及 4/8 段
  if (/^(92|43|8[23478])/.test(code) || /^(4|8)/.test(code)) return `bj${code}`;
  if (/^(5|6|9)/.test(code)) return `sh${code}`;
  return `sz${code}`;
}

function toEastmoneySecid(code) {
  if (/^(6|9)/.test(code) && !/^(92)/.test(code)) return `1.${code}`;
  return `0.${code}`;
}

function parseHoldingsFromBox(htmlBox) {
  const rows = [...htmlBox.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  const holdings = [];
  for (const row of rows) {
    const codeM = row.match(/unify\/r\/\d\.(\d{6})/);
    if (!codeM) continue;
    const nameM = row.match(/class='tol'><a[^>]*>([^<]+)<\/a>/);
    const percents = [...row.matchAll(/>([\d.]+)%/g)].map((m) => Number(m[1]));
    if (!nameM || !percents.length) continue;
    const weight = percents[percents.length - 1];
    // 权重 0.00%（及解析异常）不纳入
    if (!Number.isFinite(weight) || weight < MIN_WEIGHT_PCT) continue;
    holdings.push({
      code: codeM[1],
      name: nameM[1],
      weight,
    });
  }
  return holdings;
}

function parseAllHoldingsPeriods(html) {
  const parts = html.split("boxitem");
  const candidates = [];
  for (let i = 1; i < parts.length; i++) {
    const box = parts[i];
    const periodM = box.match(/截止至：<font[^>]*>([\d-]+)</);
    const labelM = box.match(/(\d{4}年[1-4]季度股票投资明细)/);
    const holdings = parseHoldingsFromBox(box);
    if (!holdings.length) continue;
    const sumWeight = holdings.reduce((a, b) => a + b.weight, 0);
    const period = periodM ? periodM[1] : null;
    candidates.push({
      period,
      label: labelM ? labelM[1] : null,
      holdings,
      sumWeight,
      n: holdings.length,
      ts: period ? Date.parse(`${period}T00:00:00`) : 0,
    });
  }
  candidates.sort((a, b) => b.ts - a.ts);
  return candidates;
}

/**
 * 全量底仓 = 只数最多的一期（半年报/年报）
 * 再用最新一期（通常为季报）覆盖重仓股权重
 */
function pickMergedHoldings(html) {
  const periods = parseAllHoldingsPeriods(html);
  if (!periods.length) return null;

  const fullest = [...periods].sort(
    (a, b) => b.n - a.n || b.sumWeight - a.sumWeight || b.ts - a.ts
  )[0];
  const latest = periods[0];

  const weightByCode = new Map(fullest.holdings.map((h) => [h.code, h]));
  let updatedWeights = 0;
  if (latest && latest.period !== fullest.period) {
    for (const item of latest.holdings) {
      const exist = weightByCode.get(item.code);
      if (exist) {
        exist.weight = item.weight;
        exist.weightFrom = latest.period;
        updatedWeights += 1;
      }
    }
  }

  const holdings = [...weightByCode.values()];
  const sumWeight = Number(holdings.reduce((a, b) => a + b.weight, 0).toFixed(4));

  return {
    holdings,
    sumWeight,
    n: holdings.length,
    period: fullest.period,
    label: fullest.label,
    weightPeriod: latest && latest.period !== fullest.period ? latest.period : fullest.period,
    updatedWeights,
    latestPeriod: latest ? latest.period : null,
  };
}

function parseHoldingsHtml(html) {
  return pickMergedHoldings(html);
}

async function fetchHoldingsFromEastmoney(code) {
  const url =
    `https://fundf10.eastmoney.com/FundArchivesDatas.aspx` +
    `?type=jjcc&code=${encodeURIComponent(code)}&topline=100&year=&month=`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: "https://fundf10.eastmoney.com/",
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`持仓 HTTP ${res.status}`);
  const html = await res.text();
  const picked = parseHoldingsHtml(html);
  const holdings = (picked && picked.holdings) || [];
  if (!holdings.length) throw new Error(`持仓解析失败 ${code}`);
  const sumWeight = Number(((picked && picked.sumWeight) || 0).toFixed(4));
  return {
    code,
    updatedAt: Date.now(),
    sumWeight,
    holdings,
    period: picked.period,
    label: picked.label,
    weightPeriod: picked.weightPeriod,
    updatedWeights: picked.updatedWeights,
    periodN: holdings.length,
  };
}

function loadHoldingsFile(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data || typeof data !== "object") return null;
    return data;
  } catch {
    return null;
  }
}

function saveHoldingsFile(file, data) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

/**
 * keys: { [fundId]: holdingsSourceCode }
 */
async function loadAllHoldings({ dataDir, sources, force = false }) {
  const file = path.join(dataDir, "holdings.json");
  let cache = loadHoldingsFile(file) || { sources: {} };
  const now = Date.now();
  const jobs = [];

  for (const [fundId, srcCode] of Object.entries(sources)) {
    const prev = cache.sources && cache.sources[srcCode];
    if (!force && prev && prev.holdings && now - (prev.updatedAt || 0) < HOLDINGS_TTL_MS) {
      continue;
    }
    jobs.push(
      (async () => {
        const fresh = await fetchHoldingsFromEastmoney(srcCode);
        cache.sources = cache.sources || {};
        cache.sources[srcCode] = fresh;
        return { srcCode, ok: true };
      })().catch((e) => ({ srcCode, ok: false, error: e.message || String(e) }))
    );
  }

  const results = await Promise.all(jobs);
  if (results.some((r) => r.ok)) {
    cache.savedAt = now;
    saveHoldingsFile(file, cache);
  }

  const byFund = {};
  for (const [fundId, srcCode] of Object.entries(sources)) {
    const item = cache.sources && cache.sources[srcCode];
    byFund[fundId] = item && item.holdings ? item : null;
  }

  return {
    byFund,
    file,
    fetched: results,
  };
}

async function fetchBatchEastmoneyQuotes(codes) {
  const unique = [...new Set(codes.filter(Boolean))];
  if (!unique.length) return {};
  const out = {};
  const CHUNK = 50;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const secids = chunk.map(toEastmoneySecid).join(",");
    const url =
      `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=${secids}` +
      `&fields=f12,f14,f2,f3,f18&ut=fa5fd1943c7b386f172d6893dbfba10b`;
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Referer: "https://quote.eastmoney.com/",
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const diff = json && json.data && json.data.diff;
      if (!Array.isArray(diff)) continue;
      for (const row of diff) {
        const code = String(row.f12 || "");
        if (!code) continue;
        const price = Number(row.f2) / 100;
        const prevClose = Number(row.f18) / 100;
        const pctField = Number(row.f3) / 100;
        if (!Number.isFinite(price) || price <= 0) continue;
        const pct = Number.isFinite(pctField)
          ? pctField
          : Number.isFinite(prevClose) && prevClose > 0
            ? ((price - prevClose) / prevClose) * 100
            : null;
        if (pct == null) continue;
        out[code] = {
          code,
          price,
          prevClose,
          pct: Number(pct.toFixed(4)),
          name: row.f14 || "",
          source: "eastmoney",
        };
      }
    } catch {
      // 单块失败忽略，剩余块继续
    }
  }
  return out;
}

async function fetchBatchTencentQuotes(symbols) {
  const unique = [...new Set(symbols.filter(Boolean))];
  if (!unique.length) return {};

  const out = {};
  const CHUNK = 50;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const url = `https://qt.gtimg.cn/q=${chunk.join(",")}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://gu.qq.com/" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`腾讯批量 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const text = new TextDecoder("gbk").decode(buf);
    for (const m of text.matchAll(/v_([a-z]{2}\d+)="([^"]+)"/g)) {
      const key = m[1];
      const p = m[2].split("~");
      const price = Number(p[3]);
      const prevClose = Number(p[4]);
      const pctField = Number(p[32]);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(prevClose)) continue;
      const pct = Number.isFinite(pctField)
        ? pctField
        : ((price - prevClose) / prevClose) * 100;
      const code = key.replace(/^[a-z]+/, "");
      out[code] = {
        symbol: key,
        code,
        price,
        prevClose,
        pct: Number(pct.toFixed(4)),
        name: p[1] || "",
        source: "tencent",
      };
    }
  }

  // 腾讯缺失的用东财补
  const missing = unique
    .map((sym) => sym.replace(/^[a-z]+/, ""))
    .filter((code) => code && (!out[code] || !Number.isFinite(out[code].pct)));
  if (missing.length) {
    const fallback = await fetchBatchEastmoneyQuotes(missing);
    for (const [code, q] of Object.entries(fallback)) {
      out[code] = q;
    }
  }

  return out;
}

/**
 * 持仓加权估值
 * weight 占净值%
 * estimate = Σ(w/100 * pct) + 未覆盖股票部分 * 已覆盖均值
 * 再乘 holdingsScale（联接基金对标的 ETF 的仓位近似）
 */
function estimateFromHoldings(holdingsPayload, quoteMap, { scale = 1, equity = null } = {}) {
  if (!holdingsPayload || !Array.isArray(holdingsPayload.holdings)) {
    return { ok: false, reason: "无持仓" };
  }
  const list = holdingsPayload.holdings;
  let coveredWeight = 0;
  let contrib = 0;
  let matched = 0;
  const top = [];

  for (const item of list) {
    const q = quoteMap[item.code];
    if (!q || !Number.isFinite(q.pct)) continue;
    coveredWeight += item.weight;
    contrib += (item.weight / 100) * q.pct;
    matched += 1;
    if (top.length < 5) {
      top.push({
        code: item.code,
        name: item.name,
        weight: item.weight,
        pct: q.pct,
      });
    }
  }

  if (!matched || coveredWeight <= 0) {
    return { ok: false, reason: "持仓行情未匹配" };
  }

  const covered = coveredWeight / 100;
  const avgCovered = contrib / covered;
  const eq = equity != null ? equity : Math.min(1, covered);
  const residual = Math.max(0, eq - covered);
  const raw = contrib + residual * avgCovered;
  const pct = Number((raw * scale).toFixed(4));

  return {
    ok: true,
    pct,
    method: "holdings",
    matched,
    total: list.length,
    coveredWeight: Number(coveredWeight.toFixed(2)),
    equity: eq,
    scale,
    residualWeight: Number((residual * 100).toFixed(2)),
    sumWeight: holdingsPayload.sumWeight,
    holdingsCode: holdingsPayload.code,
    updatedAt: holdingsPayload.updatedAt,
    top,
  };
}

module.exports = {
  toTencentSymbol,
  toEastmoneySecid,
  parseHoldingsHtml,
  fetchHoldingsFromEastmoney,
  loadAllHoldings,
  fetchBatchTencentQuotes,
  fetchBatchEastmoneyQuotes,
  estimateFromHoldings,
  loadHoldingsFile,
  saveHoldingsFile,
};
