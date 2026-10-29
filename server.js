const http = require("http");
const fs = require("fs");
const path = require("path");
const {
  toTencentSymbol,
  loadAllHoldings,
  fetchBatchTencentQuotes,
  estimateFromHoldings,
} = require("./holdings");

const PORT = process.env.PORT || 5173;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DAILY_EST_FILE = path.join(DATA_DIR, "daily-estimates.json");
const KEEP_DAYS = 30;
const KEEP_DAILY_EST_DAYS = 400;
const REFRESH_MS = 3 * 60 * 1000;

const FUNDS = [
  {
    id: "ai",
    name: "易方达人工智能ETF联接C",
    code: "012734",
    secid: "0.159819",
    tencent: "sz159819",
    refName: "人工智能ETF易方达 159819",
    color: "#3b82f6",
    lastNav: 2.0737,
    lastNavDate: "2026-09-22",
    // 联接基金自身直接股票仓位极低，用标的 ETF 159819 持仓穿透
    holdingsSource: "159819",
    // 联接基金对标的 ETF 仓位近似（留少量现金）
    holdingsScale: 0.95,
    holdingsEquity: 1,
    // 持仓加权作为主估值，指数/ETF 仅作对比
    preferHoldings: true,
  },
  {
    id: "nev",
    name: "天弘中证新能源汽车指数C",
    code: "011513",
    secid: "2.930997",
    tencent: "sh515030",
    refName: "中证新能源汽车指数 930997",
    color: "#f59e0b",
    lastNav: 1.0172,
    lastNavDate: "2026-09-22",
    // 指数基金直接持股
    holdingsSource: "011513",
    holdingsScale: 1,
    // 2026Q2 股票仓位约 91.56%
    holdingsEquity: 0.9156,
    preferHoldings: true,
  },
];

const historyCache = new Map(); // code -> { at, points }

const HOLDINGS_SOURCES = FUNDS.reduce((acc, f) => {
  if (f.holdingsSource) acc[f.id] = f.holdingsSource;
  return acc;
}, {});

const holdingsState = {
  byFund: {},
  file: null,
  lastOkAt: null,
  lastError: null,
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const collector = {
  lastAt: null,
  lastOk: null,
  lastError: null,
  nextAt: Date.now() + REFRESH_MS,
  count: 0,
};

/** SSE 客户端集合 */
const sseClients = new Set();
const SSE_HEARTBEAT_MS = 15000;

function p2(n) {
  return String(n).padStart(2, "0");
}

function dayKeyOf(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

function formatTime(ts) {
  const d = new Date(ts);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

function sessionRangeOf(ts) {
  const d = new Date(ts);
  const start = new Date(d);
  start.setHours(9, 30, 0, 0);
  const end = new Date(d);
  end.setHours(15, 0, 0, 0);
  return { start: start.getTime(), end: end.getTime() };
}

function inSession(ts) {
  const { start, end } = sessionRangeOf(ts);
  if (ts < start || ts > end) return false;
  // 午休 11:30–13:00 不交易
  const d = new Date(ts);
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins <= 11 * 60 + 30 || mins >= 13 * 60;
}

function isWeekday(ts) {
  const day = new Date(ts).getDay();
  return day >= 1 && day <= 5;
}

function dataFile(dayKey) {
  return path.join(DATA_DIR, `${dayKey}.json`);
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readDay(dayKey) {
  try {
    const file = dataFile(dayKey);
    if (!fs.existsSync(file)) {
      return { date: dayKey, updatedAt: null, points: [] };
    }
    const raw = fs.readFileSync(file, "utf8");
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.points)) {
      return { date: dayKey, updatedAt: null, points: [] };
    }
    return data;
  } catch {
    return { date: dayKey, updatedAt: null, points: [] };
  }
}

function writeDay(dayKey, data) {
  ensureDataDir();
  const file = dataFile(dayKey);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function readDailyEstimates() {
  try {
    if (!fs.existsSync(DAILY_EST_FILE)) return { days: {} };
    const data = JSON.parse(fs.readFileSync(DAILY_EST_FILE, "utf8"));
    if (!data || typeof data !== "object" || typeof data.days !== "object") {
      return { days: {} };
    }
    return data;
  } catch {
    return { days: {} };
  }
}

function writeDailyEstimates(data) {
  ensureDataDir();
  const tmp = `${DAILY_EST_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, DAILY_EST_FILE);
}

/** 每次采集成功后覆盖写入当日终值（最后一次采集即当日系统估值结果） */
function saveDailyCloseEstimate(dayKey, values, detail, timeLabel) {
  const store = readDailyEstimates();
  const funds = {};
  for (const fund of FUNDS) {
    if (values[fund.id] == null) continue;
    const d = detail[fund.id] || {};
    funds[fund.id] = {
      pct: values[fund.id],
      estNav: d.estNav != null ? d.estNav : estNav(fund, values[fund.id]),
      baseNav: d.baseNav != null ? d.baseNav : fund.lastNav,
      baseNavDate: d.baseNavDate != null ? d.baseNavDate : fund.lastNavDate,
      method: d.method || null,
      methodLabel: d.methodLabel || null,
      timeLabel,
    };
  }
  store.days[dayKey] = {
    date: dayKey,
    updatedAt: Date.now(),
    funds,
  };

  const keys = Object.keys(store.days).sort();
  if (keys.length > KEEP_DAILY_EST_DAYS) {
    for (const k of keys.slice(0, keys.length - KEEP_DAILY_EST_DAYS)) {
      delete store.days[k];
    }
  }
  writeDailyEstimates(store);
}

/** 用已有日文件最后一条点位回填历史系统终值（补齐 daily-estimates 缺口） */
function backfillDailyEstimatesFromDayFiles() {
  const store = readDailyEstimates();
  const dayFiles = listDays();
  let added = 0;

  for (const dayKey of dayFiles) {
    if (store.days[dayKey] && store.days[dayKey].funds) continue;
    const day = readDay(dayKey);
    if (!day.points || !day.points.length) continue;

    // 取当日最后一条有完整估值的点
    let lastOk = null;
    for (let i = day.points.length - 1; i >= 0; i--) {
      const p = day.points[i];
      const has =
        p.values &&
        FUNDS.some((f) => p.values[f.id] != null && p.detail && p.detail[f.id] && p.detail[f.id].estNav != null);
      if (has) {
        lastOk = p;
        break;
      }
    }
    if (!lastOk) continue;

    const funds = {};
    for (const fund of FUNDS) {
      const pct = lastOk.values ? lastOk.values[fund.id] : null;
      const d = lastOk.detail ? lastOk.detail[fund.id] : null;
      if (pct == null) continue;
      funds[fund.id] = {
        pct,
        estNav: d && d.estNav != null ? d.estNav : estNav(fund, pct),
        baseNav: fund.lastNav,
        baseNavDate: fund.lastNavDate,
        method: (d && d.method) || null,
        methodLabel: (d && d.methodLabel) || null,
        timeLabel: lastOk.timeLabel,
        backfilled: true,
      };
    }
    if (!Object.keys(funds).length) continue;

    store.days[dayKey] = {
      date: dayKey,
      updatedAt: lastOk.ts || Date.parse(`${dayKey}T15:00:00`),
      funds,
    };
    added += 1;
  }

  if (added > 0) writeDailyEstimates(store);
  return added;
}

function listDays() {
  try {
    ensureDataDir();
    return fs
      .readdirSync(DATA_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
  } catch {
    return [];
  }
}

function pruneOldDays(keepDayKey) {
  try {
    const days = listDays();
    if (days.length <= KEEP_DAYS) return;
    days.slice(0, days.length - KEEP_DAYS).forEach((day) => {
      if (day !== keepDayKey) {
        const file = dataFile(day);
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
    });
  } catch {
    // ignore
  }
}

async function fetchEastmoney(secid) {
  const fields = ["f43", "f57", "f58", "f59", "f60", "f86", "f170"].join(",");
  const url =
    `https://push2.eastmoney.com/api/qt/stock/get?secid=${encodeURIComponent(secid)}` +
    `&fields=${fields}&ut=fa5fd1943c7b386f172d6893dbfba10b`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: "https://quote.eastmoney.com/",
      Accept: "*/*",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`东财 HTTP ${res.status}`);
  const json = await res.json();
  if (!json || json.rc !== 0 || !json.data) throw new Error("东财行情无效");
  return json.data;
}

function parseTencentBody(text) {
  const m = text.match(/v_[a-z]{2}\d+="([^"]+)"/);
  if (!m) throw new Error("腾讯行情格式错误");
  const p = m[1].split("~");
  const price = Number(p[3]);
  const prevClose = Number(p[4]);
  const pct = Number(p[32]);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(prevClose)) {
    throw new Error("腾讯行情字段无效");
  }
  const digits = (String(p[3]).split(".")[1] || "").length;
  const quoteName = p[1] || "";
  const timeStr = p[30] || "";
  let time = Date.now();
  if (/^\d{8}$/.test(timeStr)) {
    const hh = p[31] && false ? "" : "";
    // p[30] 是 yyyyMMddHHmmss 的日期部分? 实际 p[30]=yyyyMMdd, p[31]前是时间 — 用整体字段
  }
  // 腾讯：索引 30 为时间 yyyyMMddHHmmss（有的版本是日期）
  if (/^\d{14}$/.test(timeStr)) {
    const y = timeStr.slice(0, 4);
    const mo = timeStr.slice(4, 6);
    const d = timeStr.slice(6, 8);
    const hh = timeStr.slice(8, 10);
    const mi = timeStr.slice(10, 12);
    const ss = timeStr.slice(12, 14);
    time = new Date(`${y}-${mo}-${d}T${hh}:${mi}:${ss}`).getTime() || Date.now();
  }
  return {
    source: "tencent",
    pct: Number.isFinite(pct) ? pct : ((price - prevClose) / prevClose) * 100,
    price,
    prevClose,
    digits,
    quoteName,
    time,
  };
}

async function fetchTencent(symbol) {
  const url = `https://qt.gtimg.cn/q=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: "https://gu.qq.com/" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`腾讯 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // 腾讯返回 GBK
  const text = new TextDecoder("gbk").decode(buf);
  if (!text || text.includes("pv_none_match")) throw new Error("腾讯无此代码");
  const quote = parseTencentBody(text);
  quote.source = "tencent";
  return quote;
}

async function fetchQuote(fund) {
  const errors = [];
  try {
    const data = await fetchEastmoney(fund.secid);
    return parseQuote(data, "eastmoney");
  } catch (e) {
    errors.push(e.message || String(e));
  }
  if (fund.tencent) {
    try {
      return await fetchTencent(fund.tencent);
    } catch (e) {
      errors.push(e.message || String(e));
    }
  }
  throw new Error(errors.join(" / ") || "无可用行情源");
}

function parseQuote(data, source = "eastmoney") {
  const rawPrice = Number(data.f43);
  const rawPrev = Number(data.f60);
  const pctRaw = Number(data.f170);
  const digits = Number.isFinite(Number(data.f59)) ? Number(data.f59) : 3;
  const scale = 10 ** digits;
  const price = rawPrice / scale;
  const prevClose = rawPrev / scale;

  let pct = pctRaw / 100;
  if ((!Number.isFinite(pct) || pctRaw === 0) && price > 0 && prevClose > 0) {
    pct = ((price - prevClose) / prevClose) * 100;
  }

  return {
    source,
    pct,
    price,
    prevClose,
    digits,
    quoteName: data.f58 || "",
    time: data.f86 ? Number(data.f86) * 1000 : Date.now(),
  };
}

function estNav(fund, pct) {
  if (!Number.isFinite(pct)) return null;
  return Number((fund.lastNav * (1 + pct / 100)).toFixed(4));
}

/** 取历史里严格早于今天的最新真实净值作估算基准 */
async function getPrevRealNav(fund) {
  try {
    const points = await loadHistoryPoints(fund.code);
    const today = dayKeyOf(Date.now());
    for (let i = points.length - 1; i >= 0; i--) {
      const key = dayKeyOf(points[i].ts);
      if (key < today && Number.isFinite(points[i].nav)) {
        return { nav: points[i].nav, date: key };
      }
    }
  } catch {
    // fallthrough
  }
  return { nav: fund.lastNav, date: fund.lastNavDate };
}

async function estNavWithBase(fund, pct, baseNav) {
  if (!Number.isFinite(pct)) return null;
  const base = baseNav != null ? baseNav : fund.lastNav;
  return Number((base * (1 + pct / 100)).toFixed(4));
}

async function loadHistoryPoints(code) {
  const ttlMs = 6 * 60 * 60 * 1000;
  const cached = historyCache.get(code);
  if (cached && Date.now() - cached.at < ttlMs) return cached.points;
  const points = await fetchFundHistory(code);
  historyCache.set(code, { at: Date.now(), points });
  return points;
}

async function refreshHoldings(force = false) {
  try {
    const result = await loadAllHoldings({
      dataDir: DATA_DIR,
      sources: HOLDINGS_SOURCES,
      force,
    });
    holdingsState.byFund = result.byFund || {};
    holdingsState.file = result.file;
    holdingsState.lastOkAt = Date.now();
    holdingsState.lastError = null;
    const brief = Object.entries(holdingsState.byFund)
      .map(([id, h]) => `${id}:${h ? h.holdings.length + "只/" + h.sumWeight + "%" : "无"}`)
      .join(", ");
    console.log(`[holdings] refreshed ${brief}`);
    return result;
  } catch (e) {
    holdingsState.lastError = e.message || String(e);
    console.log(`[holdings] error ${holdingsState.lastError}`);
    throw e;
  }
}

function collectStockCodes() {
  const codes = new Set();
  for (const fund of FUNDS) {
    const h = holdingsState.byFund[fund.id];
    if (!h || !Array.isArray(h.holdings)) continue;
    for (const item of h.holdings) codes.add(item.code);
  }
  return [...codes];
}

async function buildHoldingsQuotes() {
  const codes = collectStockCodes();
  if (!codes.length) return {};
  const symbols = codes.map(toTencentSymbol);
  return fetchBatchTencentQuotes(symbols);
}

function evaluateFundEstimate(fund, stockQuotes, indexQuote) {
  const h = holdingsState.byFund[fund.id];
  let holdingsEst = null;
  if (h) {
    holdingsEst = estimateFromHoldings(h, stockQuotes, {
      scale: fund.holdingsScale != null ? fund.holdingsScale : 1,
      equity: fund.holdingsEquity != null ? fund.holdingsEquity : null,
    });
  }

  const indexPct = indexQuote && Number.isFinite(indexQuote.pct)
    ? Number(indexQuote.pct.toFixed(4))
    : null;

  let primary = null;
  let method = null;
  if (fund.preferHoldings && holdingsEst && holdingsEst.ok && Number.isFinite(holdingsEst.pct)) {
    primary = holdingsEst.pct;
    method = "holdings";
  } else if (indexPct != null) {
    primary = indexPct;
    method = "index";
  } else if (holdingsEst && holdingsEst.ok) {
    primary = holdingsEst.pct;
    method = "holdings";
  }

  return {
    pct: primary,
    method,
    holdings: holdingsEst && holdingsEst.ok ? holdingsEst : null,
    holdingsError: holdingsEst && !holdingsEst.ok ? holdingsEst.reason : null,
    indexPct,
    indexQuote,
  };
}

async function collectOnce({ broadcastUpdate = true } = {}) {
  const now = Date.now();
  collector.nextAt = now + REFRESH_MS;
  collector.lastAt = now;

  if (!isWeekday(now) || !inSession(now)) {
    collector.lastOk = false;
    collector.lastError = "非交易时段";
    if (broadcastUpdate) {
      broadcast({
        type: "status",
        ts: now,
        status: buildStatusPayload(),
        skipped: true,
      });
    }
    return { skipped: true };
  }

  try {
    if (!Object.keys(holdingsState.byFund).length) {
      try {
        await refreshHoldings(false);
      } catch {
        // 行情仍可走指数法
      }
    }

    const [indexResults, stockQuotes, prevNavs] = await Promise.all([
      Promise.all(
        FUNDS.map(async (fund) => {
          try {
            const quote = await fetchQuote(fund);
            return { fund, quote, error: null };
          } catch (e) {
            return { fund, quote: null, error: e.message || String(e) };
          }
        })
      ),
      buildHoldingsQuotes().catch(() => ({})),
      Promise.all(
        FUNDS.map(async (fund) => {
          const n = await getPrevRealNav(fund);
          return [fund.id, n];
        })
      ).then((pairs) => Object.fromEntries(pairs)).catch(() => ({})),
    ]);

    const baseNavMap = prevNavs || {};

    const okCount = indexResults.filter((r) => !r.error).length;
    const anyHoldings = Object.values(holdingsState.byFund).some(Boolean);
    if (okCount === 0 && !anyHoldings) {
      throw new Error("全部行情获取失败");
    }

    const dayKey = dayKeyOf(now);
    const day = readDay(dayKey);
    const values = {};
    const detail = {};
    let holdingsUsed = 0;

    for (const fund of FUNDS) {
      const idx = indexResults.find((r) => r.fund.id === fund.id);
      const indexQuote = idx && !idx.error ? idx.quote : null;
      const idxError = idx && idx.error ? idx.error : null;
      const est = evaluateFundEstimate(fund, stockQuotes, indexQuote);

      if (est.pct == null) {
        values[fund.id] = null;
        detail[fund.id] = {
          method: null,
          error: est.holdingsError || idxError || "无估值数据",
          estNav: null,
        };
        continue;
      }

      if (est.method === "holdings") holdingsUsed += 1;
      const baseNavInfo = baseNavMap[fund.id] || {
        nav: fund.lastNav,
        date: fund.lastNavDate,
      };
      values[fund.id] = est.pct;
      detail[fund.id] = {
        method: est.method,
        methodLabel: est.method === "holdings" ? "持仓加权" : "跟踪标的",
        pct: est.pct,
        indexPct: est.indexPct,
        holdingsPct: est.holdings ? est.holdings.pct : null,
        holdingsMeta: est.holdings
          ? {
              holdingsCode: est.holdings.holdingsCode,
              matched: est.holdings.matched,
              total: est.holdings.total,
              coveredWeight: est.holdings.coveredWeight,
              scale: est.holdings.scale,
              top: est.holdings.top,
            }
          : null,
        baseNav: baseNavInfo.nav,
        baseNavDate: baseNavInfo.date,
        estNav: Number((baseNavInfo.nav * (1 + est.pct / 100)).toFixed(4)),
        source: indexQuote ? indexQuote.source || "eastmoney" : "holdings",
        price: indexQuote
          ? Number(indexQuote.price.toFixed(indexQuote.digits))
          : null,
        prevClose: indexQuote
          ? Number(indexQuote.prevClose.toFixed(indexQuote.digits))
          : null,
        digits: indexQuote ? indexQuote.digits : null,
        quoteName: indexQuote ? indexQuote.quoteName : "",
        error: null,
      };
    }

    const okValues = Object.values(values).filter((v) => v != null).length;
    if (okValues === 0) throw new Error("全部估值计算失败");

    const timeLabel = formatTime(now);
    const last = day.points[day.points.length - 1];
    let point;
    if (last && last.timeLabel === timeLabel) {
      last.values = values;
      last.detail = detail;
      point = last;
    } else {
      point = { ts: now, timeLabel, values, detail };
      day.points.push(point);
    }

    if (day.points.length > 480) day.points = day.points.slice(-480);

    day.date = dayKey;
    day.updatedAt = now;
    writeDay(dayKey, day);
    pruneOldDays(dayKey);
    try {
      saveDailyCloseEstimate(dayKey, values, detail, timeLabel);
    } catch {
      // 终值落盘失败不影响采集
    }

    collector.lastOk = okValues === FUNDS.length;
    collector.lastError =
      okValues === FUNDS.length ? null : "部分估值失败";
    collector.count += 1;
    collector.holdingsUsed = holdingsUsed;

    if (broadcastUpdate) {
      broadcast({
        type: "update",
        ts: now,
        day,
        point,
        status: buildStatusPayload(),
      });
    }

    return {
      ok: true,
      values,
      detail,
      timeLabel,
      okCount,
      holdingsUsed,
      point,
      day,
    };
  } catch (e) {
    collector.lastOk = false;
    collector.lastError = e.message || String(e);
    if (broadcastUpdate) {
      broadcast({
        type: "error",
        ts: now,
        status: buildStatusPayload(),
        error: collector.lastError,
      });
    }
    throw e;
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function buildStatusPayload() {
  const now = Date.now();
  const holdings = {};
  for (const fund of FUNDS) {
    const h = holdingsState.byFund[fund.id];
    holdings[fund.id] = h
      ? {
          source: h.code,
          count: h.holdings.length,
          sumWeight: h.sumWeight,
          updatedAt: h.updatedAt,
        }
      : null;
  }
  return {
    funds: FUNDS,
    collector: {
      lastAt: collector.lastAt,
      lastAtLabel: collector.lastAt ? formatTime(collector.lastAt) : null,
      lastOk: collector.lastOk,
      lastError: collector.lastError,
      nextAt: collector.nextAt,
      nextLabel: formatTime(collector.nextAt),
      count: collector.count,
      inSession: inSession(now) && isWeekday(now),
      days: listDays().length,
      holdingsUsed: collector.holdingsUsed || 0,
      holdingsError: holdingsState.lastError,
      holdings,
    },
  };
}

function buildSnapshotPayload() {
  const dayKey = dayKeyOf(Date.now());
  return {
    type: "snapshot",
    ts: Date.now(),
    day: readDay(dayKey),
    status: buildStatusPayload(),
  };
}

function broadcast(obj) {
  if (!sseClients.size) return;
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(data);
    } catch {
      sseClients.delete(res);
    }
  }
}

function addSseClient(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  res.write(`data: ${JSON.stringify(buildSnapshotPayload())}\n\n`);
  sseClients.add(res);

  const cleanup = () => {
    sseClients.delete(res);
    try {
      res.end();
    } catch {
      // ignore
    }
  };

  req.on("close", cleanup);
  req.on("error", cleanup);
  res.on("error", cleanup);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function fetchFundHistory(code) {
  const url = `https://fund.eastmoney.com/pingzhongdata/${encodeURIComponent(code)}.js`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: "https://fund.eastmoney.com/",
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`历史净值 HTTP ${res.status}`);
  const text = await res.text();
  const m = text.match(/Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) throw new Error("历史净值解析失败");
  let arr;
  try {
    arr = JSON.parse(m[1]);
  } catch {
    throw new Error("历史净值 JSON 无效");
  }
  if (!Array.isArray(arr) || !arr.length) throw new Error("历史净值为空");

  const points = arr
    .filter((it) => it && Number.isFinite(it.x) && Number.isFinite(it.y))
    .map((it) => ({
      ts: it.x,
      nav: it.y,
      dailyPct: Number.isFinite(it.equityReturn) ? it.equityReturn : null,
    }));

  const base = points[0].nav;
  for (const p of points) {
    p.cumPct = base > 0 ? Number((((p.nav / base) - 1) * 100).toFixed(4)) : null;
  }
  return points;
}

async function handleApi(req, res, urlPath, parsedUrl) {
  if (req.method === "GET" && urlPath === "/api/stream") {
    return addSseClient(req, res);
  }

  if (req.method === "GET" && urlPath === "/api/history") {
    try {
      const ttlMs = 6 * 60 * 60 * 1000;
      const out = {};
      await Promise.all(
        FUNDS.map(async (fund) => {
          const cached = historyCache.get(fund.code);
          if (cached && Date.now() - cached.at < ttlMs) {
            out[fund.id] = { code: fund.code, cachedAt: cached.at, points: cached.points };
            return;
          }
          const points = await fetchFundHistory(fund.code);
          historyCache.set(fund.code, { at: Date.now(), points });
          out[fund.id] = { code: fund.code, cachedAt: Date.now(), points };
        })
      );
      return sendJson(res, 200, { ts: Date.now(), funds: out });
    } catch (e) {
      return sendJson(res, 500, { error: e.message || String(e) });
    }
  }

  if (req.method === "GET" && urlPath === "/api/status") {
    return sendJson(res, 200, buildStatusPayload());
  }

  if (req.method === "GET" && urlPath === "/api/daily-estimates") {
    return sendJson(res, 200, {
      ts: Date.now(),
      ...readDailyEstimates(),
    });
  }

  if (req.method === "GET" && urlPath === "/api/days") {
    return sendJson(res, 200, { days: listDays() });
  }

  if (req.method === "GET" && urlPath === "/api/today") {
    const dayKey = dayKeyOf(Date.now());
    return sendJson(res, 200, readDay(dayKey));
  }

  if (req.method === "GET" && urlPath === "/api/day") {
    const day = parsedUrl.searchParams.get("date") || dayKeyOf(Date.now());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return sendJson(res, 400, { error: "invalid date" });
    }
    return sendJson(res, 200, readDay(day));
  }

  if (req.method === "GET" && urlPath === "/api/holdings") {
    return sendJson(res, 200, {
      file: holdingsState.file,
      lastOkAt: holdingsState.lastOkAt,
      lastError: holdingsState.lastError,
      byFund: holdingsState.byFund,
    });
  }

  if (req.method === "GET" && urlPath === "/api/holdings/live") {
    try {
      if (!Object.keys(holdingsState.byFund).length) {
        await refreshHoldings(false);
      }
      const codes = collectStockCodes();
      const quotes = codes.length
        ? await fetchBatchTencentQuotes(codes.map(toTencentSymbol))
        : {};
      const byFund = {};
      for (const fund of FUNDS) {
        const h = holdingsState.byFund[fund.id];
        if (!h || !Array.isArray(h.holdings)) {
          byFund[fund.id] = null;
          continue;
        }
        let contrib = 0;
        let matched = 0;
        const stocks = h.holdings.map((item, i) => {
          const q = quotes[item.code] || null;
          const pct = q && Number.isFinite(q.pct) ? q.pct : null;
          const part = pct != null ? (item.weight / 100) * pct : null;
          if (part != null) {
            contrib += part;
            matched += 1;
          }
          return {
            rank: i + 1,
            code: item.code,
            name: item.name,
            weight: item.weight,
            price: q ? q.price : null,
            prevClose: q ? q.prevClose : null,
            pct,
            contrib: part != null ? Number(part.toFixed(4)) : null,
          };
        });
        byFund[fund.id] = {
          source: h.code,
          sumWeight: h.sumWeight,
          holdingsUpdatedAt: h.updatedAt,
          matched,
          total: stocks.length,
          coveredWeight: Number(
            stocks
              .filter((s) => s.pct != null)
              .reduce((a, s) => a + s.weight, 0)
              .toFixed(2)
          ),
          contribPct: Number(contrib.toFixed(4)),
          stocks,
        };
      }
      return sendJson(res, 200, { ts: Date.now(), byFund });
    } catch (e) {
      return sendJson(res, 500, { error: e.message || String(e) });
    }
  }

  if (req.method === "POST" && urlPath === "/api/holdings/refresh") {
    try {
      const result = await refreshHoldings(true);
      return sendJson(res, 200, { ok: true, fetched: result.fetched });
    } catch (e) {
      return sendJson(res, 500, { error: e.message || String(e) });
    }
  }

  if (req.method === "POST" && urlPath === "/api/collect") {
    try {
      const result = await collectOnce();
      return sendJson(res, 200, result);
    } catch (e) {
      return sendJson(res, 500, { error: e.message || String(e) });
    }
  }

  sendJson(res, 404, { error: "not found" });
}

function serveStatic(req, res, urlPath) {
  let filePath = path.normalize(path.join(ROOT, urlPath === "/" || urlPath === "/index.html" || urlPath === "/collector.html" ? "collector.html" : urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || stat.isDirectory()) {
      filePath = path.join(ROOT, "collector.html");
    }

    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(data);
    });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const rawUrl = req.url || "/";
    const urlPath = decodeURIComponent(rawUrl.split("?")[0]);
    const parsedUrl = new URL(rawUrl, `http://127.0.0.1:${PORT}`);

    if (urlPath.startsWith("/api/")) {
      await handleApi(req, res, urlPath, parsedUrl);
      return;
    }

    serveStatic(req, res, urlPath);
  } catch (e) {
    sendJson(res, 500, { error: e.message || String(e) });
  }
});

function startCollector() {
  ensureDataDir();
  try {
    const n = backfillDailyEstimatesFromDayFiles();
    if (n > 0) console.log(`[daily-est] backfilled ${n} day(s) from day files`);
  } catch (e) {
    console.log(`[daily-est] backfill failed: ${e.message || e}`);
  }
  refreshHoldings(false).catch(() => {});

  const tick = async () => {
    try {
      await collectOnce();
    } catch {
      // 已记录到 collector.lastError
    } finally {
      collector.nextAt = Date.now() + REFRESH_MS;
    }
  };

  tick();
  setInterval(tick, REFRESH_MS);
  // 每天刷新一次持仓缓存
  setInterval(() => {
    refreshHoldings(false).catch(() => {});
  }, 6 * 60 * 60 * 1000);
  setInterval(() => {
    if (!sseClients.size) return;
    for (const res of sseClients) {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        sseClients.delete(res);
      }
    }
  }, SSE_HEARTBEAT_MS);

  console.log(`[collector] every ${REFRESH_MS / 1000}s (9:30-15:00 weekdays) -> ${DATA_DIR}`);
  console.log(`[holdings] 天天基金持仓加权 enabled: ${JSON.stringify(HOLDINGS_SOURCES)}`);
  console.log(`[sse] GET /api/stream (heartbeat ${SSE_HEARTBEAT_MS / 1000}s)`);
}

server.listen(PORT, () => {
  console.log(`Fund tracker running at http://localhost:${PORT}`);
  console.log(`  - 页面: http://localhost:${PORT}/`);
  console.log(`  - 采集间隔: ${REFRESH_MS / 1000 / 60} 分钟`);
  startCollector();
});
