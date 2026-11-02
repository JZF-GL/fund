#!/usr/bin/env node
/**
 * 写入一条「猜次日涨跌」预测记录到 data/ai-predictions.json
 *
 * 用法：
 *   node scripts/save-prediction.js --fund 012734 --dir up --conf 62 \
 *     --summary "算力板块放量，趋势向上" \
 *     --reason "收盘站上5/10日均线" --reason "隔夜纳指涨1.8%" \
 *     --source "https://example.com/news"
 *
 * 参数：
 *   --fund     基金代码（012734 / 011513）或 id（ai / nev），必填
 *   --target   目标交易日 YYYY-MM-DD，缺省自动取下一个工作日
 *   --dir      up / down / flat（也接受 涨 / 跌 / 平）
 *   --conf     置信度 0-100，缺省 55
 *   --summary  一句话结论
 *   --reason  依据（可重复）
 *   --source  信息来源 URL/标题（可重复）
 *   --model   记录模型名，缺省 "opencode"
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const FILE = path.join(DATA_DIR, "ai-predictions.json");
const KEEP = 400;

const FUND_ID_BY_CODE = {
  "012734": "ai",
  "011513": "nev",
};
const CODE_BY_FUND_ID = {
  ai: "012734",
  nev: "011513",
};

function parseArgs(argv) {
  const out = { reasons: [], sources: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "";
    if (key === "reason") out.reasons.push(val);
    else if (key === "source") out.sources.push(val);
    else out[key] = val;
  }
  return out;
}

/** 上海时区的今天 */
function shanghaiToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function nextWeekday(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  do {
    d.setDate(d.getDate() + 1);
  } while (d.getDay() === 0 || d.getDay() === 6);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function normalizeDir(v) {
  const s = String(v || "").toLowerCase();
  if (["up", "涨", "+", "1"].includes(s)) return "up";
  if (["down", "跌", "-", "-1"].includes(s)) return "down";
  if (["flat", "平", "0"].includes(s)) return "flat";
  return null;
}

function readStore() {
  try {
    if (!fs.existsSync(FILE)) return { version: 1, predictions: [] };
    const raw = fs.readFileSync(FILE, "utf8").replace(/^\uFEFF/, "");
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.predictions)) return { version: 1, predictions: [] };
    return d;
  } catch {
    return { version: 1, predictions: [] };
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rawFund = String(args.fund || "").trim();
  const fundCode = CODE_BY_FUND_ID[rawFund] || rawFund;
  const fundId = FUND_ID_BY_CODE[fundCode];
  if (!fundId) {
    console.error(`未知基金：${rawFund}（支持 012734 / 011513）`);
    process.exit(1);
  }

  const direction = normalizeDir(args.dir);
  if (!direction) {
    console.error("--dir 需要 up/down/flat（或 涨/跌/平）");
    process.exit(1);
  }

  const today = shanghaiToday();
  const targetDate = args.target || nextWeekday(today);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    console.error(`--target 格式应为 YYYY-MM-DD：${targetDate}`);
    process.exit(1);
  }
  if (targetDate <= today) {
    console.error(`目标日 ${targetDate} 必须晚于今天 ${today}`);
    process.exit(1);
  }

  const confidence = Math.max(
    0,
    Math.min(100, Number(args.conf) || 55)
  );

  const record = {
    fundId,
    fundCode,
    predictDate: today,
    targetDate,
    direction,
    confidence,
    summary: String(args.summary || "").trim(),
    reasons: args.reasons.filter(Boolean),
    sources: args.sources.filter(Boolean),
    model: args.model || "opencode",
    createdAt: Date.now(),
  };

  const store = readStore();
  const before = store.predictions.length;
  store.predictions = store.predictions.filter(
    (p) => !(p && p.fundCode === fundCode && p.targetDate === targetDate)
  );
  store.predictions.push(record);
  store.predictions.sort((a, b) =>
    String(a.targetDate).localeCompare(String(b.targetDate))
  );
  if (store.predictions.length > KEEP) {
    store.predictions = store.predictions.slice(-KEEP);
  }
  store.version = 1;
  store.updatedAt = Date.now();

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n");
  fs.renameSync(tmp, FILE);

  const action = before === store.predictions.length ? "更新" : "新增";
  console.log(
    `${action} ${fundCode} 目标 ${targetDate} -> ${
      { up: "涨", down: "跌", flat: "平" }[direction]
    }（置信 ${confidence}%）`
  );
  console.log(`已写入 ${path.relative(ROOT, FILE)}`);
}

main();
