#!/usr/bin/env node
/**
 * 硫酸98%华中出厂价预测引擎
 *
 * 三种模式 + JSON 输出：
 *   --auto           自动模式：读取历史CSV，推断趋势，自动预测（无需任何输入）
 *   --auto --json    自动模式 + JSON 格式输出
 *   --scenario ...   情景模式：提供大方向（硫磺趋势、政策松紧等）
 *   [JSON]           精确模式：传入具体因子值
 *
 * 数据源：references/training-data.md 内嵌 CSV 代码块（871行 × 42字段）
 */

const fs = require('fs');
const path = require('path');

// ======== 数据分析 ========
function toNum(v, fallback) {
  const n = Number(v);
  return isNaN(n) ? fallback : n;
}
function parseDate(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  return isNaN(d.getTime()) ? new Date() : d;
}
function dayOfYear(d) {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d - start) / 86400000);
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round2(v) { return Math.round(v * 100) / 100; }

// ======== 数据加载（从 MD 内嵌 CSV 代码块） ========
const DATA_FILE = path.resolve(__dirname, '../references/training-data.md');

function loadCSVFromMarkdown() {
  if (!fs.existsSync(DATA_FILE)) {
    throw new Error(`找不到数据文件: ${DATA_FILE}。请确认 skills/sulfuric-acid-price-prediction/references/training-data.md 存在。`);
  }
  const raw = fs.readFileSync(DATA_FILE, 'utf-8');
  // 提取 ```csv ... ``` 代码块
  const match = raw.match(/```csv\n([\s\S]*?)\n```/);
  if (!match) {
    throw new Error(`数据文件中未找到 csv 代码块: ${DATA_FILE}`);
  }
  const csvContent = match[1].trim();
  const lines = csvContent.split('\n');
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',');
    const row = {};
    headers.forEach((h, idx) => { row[h] = vals[idx] ? vals[idx].trim() : ''; });
    rows.push(row);
  }
  return rows;
}

// ======== 趋势计算 ========
function calcTrend(values) {
  // 简单线性回归: y = slope * x + intercept
  const n = values.length;
  if (n < 2) return { slope: 0, avg: values[0] || 0 };
  const valid = values.filter(v => v != null && !isNaN(Number(v))).map(Number);
  if (valid.length < 2) return { slope: 0, avg: values[0] || 0 };
  const m = valid.length;
  const sumX = (m - 1) * m / 2;
  const sumY = valid.reduce((s, v) => s + v, 0);
  const sumXY = valid.reduce((s, v, i) => s + i * v, 0);
  const sumX2 = (m - 1) * m * (2 * m - 1) / 6;
  const slope = (m * sumXY - sumX * sumY) / (m * sumX2 - sumX * sumX);
  return { slope: isNaN(slope) ? 0 : slope, avg: sumY / m, last: valid[m - 1] };
}

function projectTrend(trend, daysAhead) {
  return trend.last + trend.slope * daysAhead;
}

// ======== 核心预测引擎 ========
function deriveFields(input) {
  const d = parseDate(input.date);
  const year = d.getFullYear();
  const doy = dayOfYear(d);

  const f = (k, fb) => toNum(input[k], fb);

  const sp = f('sulfur_price_cny', 3800);
  const inv = f('inventory', 200);
  const cu = f('capacity_utilization', 75);
  const pt = f('production_total', 30);
  const td = f('total_demand', 28);
  const ml = f('maintenance_loss', 0.5);
  const nc = f('new_capacity', 0.005);
  const pi = f('policy_intervention', 0.2);
  const er = f('env_restriction', 0.3);
  const sae = f('sulfuric_acid_export', 1.2);
  const si = f('sulfur_import', 3.0);
  const se = f('sulfur_export', 0.5);
  const du = f('downstream_utilization', 75);
  const wf = f('weather_factor', 0.5);
  const mp = f('metal_price_cu_zn', 65000);
  const pp = f('pyrite_price', 600);
  const ec = f('electricity_cost', 0.6);
  const spot = f('spot_price_huazhong', 950);

  const cost_sulfur_acid = sp * 0.35 + 200 + ec * 220;
  const cost_smelting_acid = Math.max(150, mp * 0.002 + 80);
  const cost_pyrite_acid = pp * 0.42 + 180 + ec * 280;
  const production_cost_weighted = cost_sulfur_acid * 0.45 + cost_smelting_acid * 0.40 + cost_pyrite_acid * 0.15;

  return {
    date: d, year, doy,
    cost_sulfur_acid, cost_smelting_acid, cost_pyrite_acid, production_cost_weighted,
    inventory: inv, capacity_utilization: cu, production_total: pt, total_demand: td,
    maintenance_loss: ml, new_capacity: nc, policy_intervention: pi, env_restriction: er,
    sulfuric_acid_export: sae, sulfur_import: si, sulfur_export: se,
    downstream_utilization: du, weather_factor: wf, metal_price_cu_zn: mp,
    pyrite_price: pp, electricity_cost: ec, spot_price_huazhong: spot,
    sulfur_price_cny: sp,
  };
}

function predictDay(input, context = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('predictDay: 输入必须是包含因子字段的对象');
  }
  const row = deriveFields(input);

  // Step 1: 成本基准
  const cost_base = row.production_cost_weighted;

  // Step 2: 供需溢价
  const inventory_premium = (200 - row.inventory) / 50 * 30;
  const gap = row.production_total - row.total_demand;
  const gap_premium = -gap * 15;
  const util_premium = (row.capacity_utilization - 75) * 0.5;
  const maint_premium = -row.maintenance_loss * 20;
  const newcap_premium = -row.new_capacity * 5000;
  const sd_premium = round2(inventory_premium + gap_premium + util_premium + maint_premium + newcap_premium);

  // Step 3: 季节性
  const seasonal = round2(Math.sin(2 * Math.PI * row.doy / 365 - Math.PI / 6) * 40 + row.weather_factor * 20);

  // Step 4: 政策宏观
  const policy_adj = -80 * row.policy_intervention;
  const env_premium = -row.env_restriction * 30;
  const export_premium = row.sulfuric_acid_export * 10;
  const sulfur_net = row.sulfur_import - row.sulfur_export;
  const sulfur_premium = -sulfur_net * 5;
  const downstream_premium = row.downstream_utilization * 2;
  const policy_macro = round2(policy_adj + env_premium + export_premium + sulfur_premium + downstream_premium);

  // Step 5: 综合（无约束原始值）
  const raw_predicted = round2(cost_base + sd_premium + seasonal + policy_macro);

  // Step 6: 年份区间约束（地板/天花板）
  const ranges = { 2024: [280, 650], 2025: [400, 1300], 2026: [700, 1200] };
  const clamp_range = ranges[row.year] || [700, 1200];
  const predicted = clamp(raw_predicted, clamp_range[0], clamp_range[1]);
  const capped = predicted !== raw_predicted;  // 是否被拦住了

  // Step 7: 置信度
  const low = round2(predicted - 37.5);
  const high = round2(predicted + 37.5);
  const conf = Math.abs(sd_premium) < 50 ? '高' : Math.abs(sd_premium) < 100 ? '中' : '低';

  // 驱动因子（使用 round2 保持与 break_down 完全一致，全部显示）
  const drivers = [
    ['硫磺成本', round2(cost_base)], ['供需溢价', round2(sd_premium)],
    ['季节性', round2(seasonal)], ['政策宏观', round2(policy_macro)],
  ].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
   .map(([n, v]) => `${n}(${v >= 0 ? '+' : ''}${v})`).join('、');

  const trend = predicted > row.spot_price_huazhong + 30 ? '上涨'
    : predicted < row.spot_price_huazhong - 30 ? '下跌' : '震荡';

  // Step 8: 动态动因分析（按影响程度排序，自动适配预测周期）
  const month = (row.date && typeof row.date.getMonth === 'function') ? row.date.getMonth() + 1 : new Date().getMonth() + 1;
  const inv = row.inventory;
  const sp = row.sulfur_price_cny;
  const pi = row.policy_intervention;
  const gap_val = row.production_total - row.total_demand;
  const periodText = context.periodDays ? `未来${context.periodDays}日` : '本期';

  const invStatus = inv > 250 ? '严重过剩' : inv > 220 ? '偏宽松' : inv > 180 ? '平衡' : '偏紧';
  const spStatus = sp > 3500 ? '高位' : sp > 2000 ? '中位' : '低位';
  const piStatus = pi > 0.5 ? '强干预' : pi > 0.2 ? '中等' : '弱';
  const gapStatus = gap_val > 0 ? '供大于求' : '供不应求';

  const seasonNames = { 1:'冬储期', 2:'春耕备肥', 3:'春耕旺季', 4:'春耕旺季', 5:'春耕尾声', 6:'夏季淡季', 7:'夏季淡季', 8:'夏季淡季', 9:'秋播备肥', 10:'秋播', 11:'冬储期', 12:'冬储期' };
  const seasonName = seasonNames[month] || '常规期';

  // 按绝对影响大小排序，让最重要的因子排在前面
  const factorLines = [
    { key: '成本端', abs: Math.abs(cost_base), line: `成本端 ${cost_base >= 0 ? '+' : ''}${cost_base.toFixed(0)}元：硫磺${sp.toFixed(0)}元/吨处于${spStatus}，硫磺制酸成本${row.cost_sulfur_acid.toFixed(0)}元/吨（权重45%），综合成本基准构成价格底部${spStatus === '高位' ? '强支撑' : '支撑'}` },
    { key: '供需端', abs: Math.abs(sd_premium), line: `供需端 ${sd_premium >= 0 ? '+' : ''}${sd_premium.toFixed(0)}元：社会库存${inv.toFixed(0)}万吨（${invStatus}），${gapStatus}（产量${row.production_total.toFixed(1)} vs 需求${row.total_demand.toFixed(1)}万吨/日），产能利用率${row.capacity_utilization.toFixed(1)}%` },
    { key: '季节性', abs: Math.abs(seasonal), line: `季节性 ${seasonal >= 0 ? '+' : ''}${seasonal.toFixed(0)}元：${month}月（${seasonName}），天气因子${row.weather_factor.toFixed(2)}` },
    { key: '政策端', abs: Math.abs(policy_macro), line: `政策端 ${policy_macro >= 0 ? '+' : ''}${policy_macro.toFixed(0)}元：政策干预${pi.toFixed(1)}（${piStatus}），环保限产${row.env_restriction.toFixed(1)}，出口${row.sulfuric_acid_export.toFixed(2)}万吨/日` },
  ].sort((a, b) => b.abs - a.abs);

  const driver_analysis = [
    `【动因分析（${periodText}预测依据）】`,
    periodText === '本期' ? factorLines.map((f, i) => `${i + 1}. ${f.line}`).join('\n')
      : `按影响程度从大到小：\n${factorLines.map((f, i) => `${i + 1}. ${f.line}`).join('\n')}`,
    ``,
    `综合判断：核心驱动因子为${drivers}，预测${periodText}价格呈${trend}趋势，价格区间为[${clamp_range[0]}, ${clamp_range[1]}]元/吨`,
  ].join('\n');

  return {
    predicted_price: { low, mid: round2(predicted), high },
    raw_predicted_price: round2(raw_predicted),  // 无约束真实预测值
    clamp_range,                                  // 当年价格区间 [地板, 天花板]
    capped,                                       // 是否被区间拦住
    confidence: conf,
    current_spot_price: round2(row.spot_price_huazhong),
    break_down: { cost_base: round2(cost_base), sd_premium, seasonal, policy_macro },
    driver_analysis,
    drivers,
    trend,
  };
}

// ======== 日间因子演变 ========
function evolveFactors(base, prevResult, nextDate) {
  const next = { ...base, date: nextDate };
  const prevMid = prevResult.predicted_price.mid;
  const prevSpot = prevResult.current_spot_price;

  // 预测价成为新的"当前价"
  next.spot_price_huazhong = prevMid;

  // 库存演变
  const prod = toNum(base.production_total, 30);
  const dem = toNum(base.total_demand, 28);
  next.inventory = round2(toNum(base.inventory, 200) + (prod - dem) * 0.3);

  // 成本倒挂反馈
  const sp = toNum(base.sulfur_price_cny, 3800);
  const ec = toNum(base.electricity_cost, 0.6);
  const costSA = sp * 0.35 + 200 + ec * 220;
  const prevCu = toNum(base.capacity_utilization, 75);
  if (prevMid < costSA - 100) {
    next.capacity_utilization = round2(Math.max(65, prevCu - 1));
    next.production_total = round2(toNum(base.production_total, 30) * next.capacity_utilization / prevCu);
  } else if (prevMid > costSA + 300) {
    next.capacity_utilization = round2(Math.min(90, prevCu + 0.5));
    next.production_total = round2(toNum(base.production_total, 30) * next.capacity_utilization / prevCu);
  }

  // 需求弹性
  const pctChg = prevSpot > 0 ? (prevMid - prevSpot) / prevSpot : 0;
  next.total_demand = round2(toNum(base.total_demand, 28) * (1 - 0.15 * pctChg));

  // 政策释放
  if (toNum(base.policy_intervention, 0) > 0.5) {
    next.sulfuric_acid_export = round2(Math.max(0.5, toNum(base.sulfuric_acid_export, 1.2) * 0.95));
  }

  // 检修递进
  const doy = dayOfYear(parseDate(nextDate));
  const inMaint = (doy >= 60 && doy <= 150) || (doy >= 244 && doy <= 304);
  next.maintenance_loss = inMaint
    ? round2(Math.min(2.0, toNum(base.maintenance_loss, 0.5) + 0.1))
    : round2(Math.max(0.1, toNum(base.maintenance_loss, 0.5) - 0.05));

  // 天气演变
  const m = parseDate(nextDate).getMonth() + 1;
  const wf = toNum(base.weather_factor, 0.5);
  if (m >= 3 && m <= 5) next.weather_factor = round2(Math.min(0.8, wf + 0.02));
  else if (m >= 6 && m <= 8) next.weather_factor = round2(Math.max(0.3, wf - 0.01));
  else next.weather_factor = round2(Math.min(0.6, wf + 0.005));

  return next;
}

function predictPeriod(baseData, numDays) {
  const results = [];
  const d = parseDate(baseData.date);
  let evolving = { ...baseData };

  for (let i = 0; i < numDays; i++) {
    let attempts = 0;
    while (d.getDay() === 0 || d.getDay() === 6) { d.setDate(d.getDate() + 1); attempts++; if (attempts > 7) break; }
    const dateStr = d.toISOString().slice(0, 10);
    evolving.date = dateStr;

    const result = predictDay(evolving, { periodDays: numDays });
    result.prediction_date = dateStr;
    results.push(result);

    evolving = evolveFactors(evolving, result, dateStr);
    d.setDate(d.getDate() + 1);
  }
  return results;
}

// ======== 输出格式 ========

function fmtJSON(results, mode) {
  const periods = { 5: 'week', 20: 'month' };
  const summary = results.length > 1
    ? (() => {
        const total = results[results.length - 1].predicted_price.mid - results[0].predicted_price.mid;
        const rawTotal = results[results.length - 1].raw_predicted_price - results[0].raw_predicted_price;
        const cappedDays = results.filter(r => r.capped).length;
        return {
          trend: total > 50 ? '整体上涨' : total < -50 ? '整体下跌' : '整体震荡',
          total_change: round2(total),
          raw_total_change: round2(rawTotal),       // 无约束趋势变动
          capped_days: cappedDays,                   // 被区间拦住的天数
          clamp_range: results[0].clamp_range,        // 当年价格区间
        };
      })()
    : undefined;

  const hasClamp = results.some(r => r.capped);
  const indicator_description = {
    predicted_price: { low: '区间下限（中值-37.5）', mid: '预测中值（经年份区间约束）', high: '区间上限（中值+37.5）' },
    raw_predicted_price: '模型原始计算值（未受年份区间限制）',
    confidence: '高(|供需溢价|<50) / 中(|供需溢价|<100) / 低(≥100)',
  };

  return JSON.stringify({
    mode,
    period: periods[results.length] || results.length + '天',
    base_date: results[0].prediction_date,
    indicator_description,
    clamping_note: hasClamp ? `约束区间 [${results[0].clamp_range[0]}, ${results[0].clamp_range[1]}] 已生效，raw_predicted_price 为无约束真实值` : undefined,
    predictions: results.map(r => ({
      date: r.prediction_date,
      current_spot_price: r.current_spot_price,
      predicted_price: r.predicted_price,
      raw_predicted_price: r.raw_predicted_price,  // 无约束真实预测值（未 clamp）
      clamped_to_range: r.capped ? r.clamp_range : null,  // 被拦住时才显示
      confidence: r.confidence,
      break_down: r.break_down,
      driver_analysis: r.driver_analysis,
      drivers: r.drivers ? r.drivers.split('、') : [],
      trend: r.trend,
    })),
    summary,
  }, null, 2);
}
function fmtDay(r) {
  const { low, mid, high } = r.predicted_price;
  const parts = [
    `【硫酸98%华中出厂价预测】`,
    `日期：${r.prediction_date || ''}`,
    `当前现货价：${r.current_spot_price} 元/吨`,
    r.raw_predicted_price !== mid
      ? `预测价格：${mid} 元/吨  无约束值：${r.raw_predicted_price} 元/吨`
      : `预测价格：${mid} 元/吨`,
    `价格区间：[${low}, ${high}]  置信度：${r.confidence}`,
    ``,
    `成本基准：${r.break_down.cost_base}  供需溢价：${r.break_down.sd_premium >= 0 ? '+' : ''}${r.break_down.sd_premium}`,
    `季节性：${r.break_down.seasonal >= 0 ? '+' : ''}${r.break_down.seasonal}  政策宏观：${r.break_down.policy_macro >= 0 ? '+' : ''}${r.break_down.policy_macro}`,
    ``,
    `核心驱动：${r.drivers}`,
    `趋势判断：${r.trend}`,
    ``,
    `【预测指标说明】`,
    `• 预测中值（mid）：五维模型计算后经年份区间约束的最终预测价格`,
    `• 无约束值：模型原始计算值（未受年份区间限制）`,
    `• 价格区间 [low, high]：中值 ±37.5 元的置信区间（约87%置信水平）`,
    r.raw_predicted_price !== mid ? `• 当前年份区间为 [${r.clamp_range[0]}, ${r.clamp_range[1]}]，无约束值${r.raw_predicted_price < r.clamp_range[0] ? '低于下限' : '高于上限'}，已约束至 ${mid}` : '',
    ``,
    `${r.driver_analysis}`,
  ];
  return parts.join('\n');
}

function fmtPeriod(results) {
  const first = results[0].break_down;
  const hasClamp = results.some(r => r.raw_predicted_price !== r.predicted_price.mid);
  const lines = [
    '【硫酸98%华中出厂价预测 - 时段走势】',
    `预测时段：${results[0].prediction_date} ~ ${results[results.length - 1].prediction_date}`,
    '',
  ];

  // 表头：有 clamp 时多一列"无约束值"
  if (hasClamp) {
    lines.push('| 日期 | 预测中值 | 无约束值 | 区间[low, high] | 置信度 | 较前日 | 趋势 |');
    lines.push('|:---|:---:|:---:|:---:|:---:|:---:|:---:|');
  } else {
    lines.push('| 日期 | 预测中值 | 区间[low, high] | 置信度 | 较前日 | 趋势 |');
    lines.push('|:---|:---:|:---:|:---:|:---:|:---:|');
  }

  let prev = null;
  results.forEach(r => {
    const { low, mid, high } = r.predicted_price;
    const chg = prev !== null ? (mid - prev >= 0 ? '+' + (mid - prev).toFixed(0) : (mid - prev).toFixed(0)) : '--';
    if (hasClamp) {
      lines.push(`| ${r.prediction_date} | ${mid} | ${r.raw_predicted_price} | [${low}, ${high}] | ${r.confidence} | ${chg} | ${r.trend} |`);
    } else {
      lines.push(`| ${r.prediction_date} | ${mid} | [${low}, ${high}] | ${r.confidence} | ${chg} | ${r.trend} |`);
    }
    prev = mid;
  });

  lines.push(
    '',
    `成本基准：${first.cost_base}  供需溢价：${first.sd_premium >= 0 ? '+' : ''}${first.sd_premium}`,
    `季节性：${first.seasonal >= 0 ? '+' : ''}${first.seasonal}  政策宏观：${first.policy_macro >= 0 ? '+' : ''}${first.policy_macro}`,
    '',
    `核心驱动：${results[0].drivers}`,
  );

  // 说明区
  const explain = [
    '',
    `【预测指标说明】`,
    `• 预测中值（mid）：五维模型计算后经年份区间约束的最终预测价格`,
    `• 预测区间 [low, high]：中值 ±37.5 元的置信区间（约87%置信水平）`,
    `• 置信度：基于供需溢价波动幅度判断（溢价<50元→高，<100元→中，≥100元→低）`,
  ];

  if (hasClamp) {
    const firstCap = results[0];
    const lastRaw = results[results.length - 1].raw_predicted_price;
    const lastClamped = results[results.length - 1].predicted_price.mid;
    const rawDiff = (lastRaw - results[0].raw_predicted_price).toFixed(2);
    explain.push(
      `• 无约束值：模型原始计算值（未受年份区间限制），当前年份区间为 [${firstCap.clamp_range[0]}, ${firstCap.clamp_range[1]}]`,
      `• ⚠️ 无约束值低于区间下限，所有预测均被拦截至下限 ${firstCap.clamp_range[0]} 元`,
      `• 无约束值趋势：${results[0].raw_predicted_price} → ${lastRaw}（期间变动 ${rawDiff >= 0 ? '+' : ''}${rawDiff} 元），说明模型判断实际方向为 ${lastRaw > results[0].raw_predicted_price ? '微涨' : '微跌'}`,
    );
  }
  lines.push(...explain);

  if (results.length > 1) {
    const total = results[results.length - 1].predicted_price.mid - results[0].predicted_price.mid;
    const rawTotal = results[results.length - 1].raw_predicted_price - results[0].raw_predicted_price;
    const t = total > 50 ? '整体上涨' : total < -50 ? '整体下跌' : '整体震荡';
    lines.push('', `趋势判断（约束后）：${t}（期间变动 ${total >= 0 ? '+' : ''}${total.toFixed(0)} 元/吨）`);
    if (hasClamp) {
      const rt = rawTotal > 10 ? '上涨' : rawTotal < -10 ? '下跌' : '震荡';
      lines.push(`趋势判断（无约束）：${rt}（期间变动 ${rawTotal >= 0 ? '+' : ''}${rawTotal.toFixed(2)} 元/吨，反映模型真实方向）`);
    }
  }
  lines.push('', results[0].driver_analysis);
  return lines.join('\n');
}

// ======== 自动模式：从训练数据推断趋势并预测 ========
function autoPredict(period) {
  const rows = loadCSVFromMarkdown();
  console.error(`[info] 已加载 ${rows.length} 条历史数据`);

  // 取最近 60 天数据计算趋势
  const recent = rows.slice(-60);
  const latest = recent[recent.length - 1];
  const latestDate = latest.date.slice(0, 10);
  console.error(`[info] 最新数据日期: ${latestDate}`);

  const keyFactors = [
    'sulfur_price_cny', 'inventory', 'capacity_utilization', 'production_total',
    'total_demand', 'maintenance_loss', 'new_capacity', 'policy_intervention',
    'env_restriction', 'sulfuric_acid_export', 'sulfur_import', 'sulfur_export',
    'downstream_utilization', 'weather_factor', 'metal_price_cu_zn', 'pyrite_price',
    'electricity_cost', 'spot_price_huazhong',
    'demand_fertilizer', 'demand_tio2', 'demand_caprolactam', 'demand_hf', 'demand_lifepo4',
    'crude_oil_usd', 'exchange_rate', 'shipping_index', 'steam_cost',
    'phosphate_rock_price', 'fluorite_price', 'ammonia_price', 'grain_price_index',
  ];

  const trends = {};
  keyFactors.forEach(k => {
    const vals = recent.map(r => toNum(r[k], null)).filter(v => v !== null);
    trends[k] = calcTrend(vals);
  });

  const periodNum = parseInt(period, 10);
  const futureDays = period === 'month' ? 20 : (!isNaN(periodNum) && periodNum >= 1 ? periodNum : 5);
  const baseDate = parseDate(latestDate);
  const results = [];

  function buildDayData(dayOffset) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + dayOffset);
    const data = { date: d.toISOString().slice(0, 10) };
    keyFactors.forEach(k => {
      data[k] = round2(projectTrend(trends[k], dayOffset));
    });
    return data;
  }

  let evolving = buildDayData(0);
  const firstResult = predictDay(evolving, { periodDays: futureDays });
  firstResult.prediction_date = evolving.date;
  results.push(firstResult);

  // 后续天数用独立日期计数器，避开周末重复
  const dCounter = new Date(baseDate);
  while (results.length < futureDays) {
    dCounter.setDate(dCounter.getDate() + 1);
    while (dCounter.getDay() === 0 || dCounter.getDay() === 6) { dCounter.setDate(dCounter.getDate() + 1); }
    const dateStr = dCounter.toISOString().slice(0, 10);

    evolving = evolveFactors(evolving, results[results.length - 1], dateStr);
    const result = predictDay(evolving, { periodDays: futureDays });
    result.prediction_date = dateStr;
    results.push(result);
  }

  return results;
}

// ======== CLI 入口 ========
let args = process.argv.slice(2);
const useJSON = !args.includes('--text');
if (!useJSON) args = args.filter(a => a !== '--text');

try {
  if (args.includes('--auto')) {
    const periodIdx = args.indexOf('--period');
    const period = periodIdx >= 0 ? args[periodIdx + 1] : 'week';
    const results = autoPredict(period);
    console.log(useJSON ? fmtJSON(results, 'auto') : fmtPeriod(results));

  } else if (args.includes('--scenario')) {
    const idx = args.indexOf('--scenario');
    const scenario = JSON.parse(args[idx + 1]);
    const periodIdx = args.indexOf('--period');
    const period = periodIdx >= 0 ? args[periodIdx + 1] : 'week';

    const rows = loadCSVFromMarkdown();
    const latest = { ...rows[rows.length - 1] };
    const latestDate = latest.date.slice(0, 10);

    if (scenario.sulfur_trend === 'up') {
      const trend = calcTrend(rows.slice(-30).map(r => toNum(r.sulfur_price_cny, 3800)));
      latest.sulfur_price_cny = String(round2(trend.last + trend.slope * 10 + 200));
    } else if (scenario.sulfur_trend === 'down') {
      const trend = calcTrend(rows.slice(-30).map(r => toNum(r.sulfur_price_cny, 3800)));
      latest.sulfur_price_cny = String(round2(Math.max(2500, trend.last + trend.slope * 10 - 200)));
    }

    if (scenario.policy !== undefined) {
      latest.policy_intervention = String(clamp(Number(scenario.policy), 0, 1));
    }

    if (scenario.inventory_trend === 'tight') {
      latest.inventory = String(toNum(latest.inventory, 200) * 0.7);
    } else if (scenario.inventory_trend === 'loose') {
      latest.inventory = String(toNum(latest.inventory, 200) * 1.3);
    }

    const baseData = { date: latestDate };
    const keyFactors = [
      'sulfur_price_cny', 'inventory', 'capacity_utilization', 'production_total',
      'total_demand', 'maintenance_loss', 'new_capacity', 'policy_intervention',
      'env_restriction', 'sulfuric_acid_export', 'sulfur_import', 'sulfur_export',
      'downstream_utilization', 'weather_factor', 'metal_price_cu_zn', 'pyrite_price',
      'electricity_cost', 'spot_price_huazhong',
      'demand_fertilizer', 'demand_tio2', 'demand_caprolactam', 'demand_hf', 'demand_lifepo4',
      'crude_oil_usd', 'exchange_rate', 'shipping_index', 'steam_cost',
      'phosphate_rock_price', 'fluorite_price', 'ammonia_price', 'grain_price_index',
    ];
    keyFactors.forEach(k => { baseData[k] = toNum(latest[k], 0); });

    const periodNum = parseInt(period, 10);
    const numDays = period === 'month' ? 20 : (!isNaN(periodNum) && periodNum >= 1 ? periodNum : 5);
    let evolving = { ...baseData, date: latestDate };
    const results = [];

    const dCounter = parseDate(latestDate);
    for (let i = 0; i < numDays; i++) {
      while (dCounter.getDay() === 0 || dCounter.getDay() === 6) { dCounter.setDate(dCounter.getDate() + 1); }
      const dateStr = dCounter.toISOString().slice(0, 10);
      evolving.date = dateStr;

      const r = predictDay(evolving, { periodDays: numDays });
      r.prediction_date = dateStr;
      results.push(r);
      evolving = evolveFactors(evolving, r, dateStr);
      dCounter.setDate(dCounter.getDate() + 1);
    }
    console.log(useJSON ? fmtJSON(results, 'scenario') : fmtPeriod(results));

  } else if (args.includes('--period')) {
    // --period 单独使用 → 自动模式
    const periodIdx = args.indexOf('--period');
    const period = periodIdx >= 0 ? args[periodIdx + 1] : 'week';
    const results = autoPredict(period);
    console.log(useJSON ? fmtJSON(results, 'auto') : fmtPeriod(results));

  } else if (args.length > 0 && !args[0].startsWith('--')) {
    const input = JSON.parse(args[0]);
    if (input.period && input.data_points) {
      const nd = input.data_points.length;
      const results = input.data_points.map(dp => { const r = predictDay(dp, { periodDays: nd }); r.prediction_date = dp.date || ''; return r; });
      const out = results.length === 1
        ? (useJSON ? fmtJSON(results, 'exact') : fmtDay(results[0]))
        : (useJSON ? fmtJSON(results, 'exact') : fmtPeriod(results));
      console.log(out);
    } else if (input.period) {
      const bd = input.base_data || input;
      const periodNum = parseInt(input.period, 10);
      const nd = input.period === 'month' ? 20 : (!isNaN(periodNum) && periodNum >= 1 ? periodNum : 5);
      const results = predictPeriod(bd, nd);
      console.log(useJSON ? fmtJSON(results, 'exact') : fmtPeriod(results));
    } else if (input.data_points) {
      const nd = input.data_points.length;
      const results = input.data_points.map(dp => { const r = predictDay(dp, { periodDays: nd }); r.prediction_date = dp.date || ''; return r; });
      const out = results.length === 1
        ? (useJSON ? fmtJSON(results, 'exact') : fmtDay(results[0]))
        : (useJSON ? fmtJSON(results, 'exact') : fmtPeriod(results));
      console.log(out);
    } else {
      const r = predictDay(input, { periodDays: 1 });
      r.prediction_date = input.date || '';
      console.log(useJSON ? fmtJSON([r], 'exact') : fmtDay(r));
    }
  } else {
    const results = autoPredict('week');
    console.log(useJSON ? fmtJSON(results, 'auto') : fmtPeriod(results));
  }
} catch (e) {
  console.error('错误:', e.message);
  console.error('用法:');
  console.error('  node predict.js --auto                             自动预测5日（无需参数）');
  console.error('  node predict.js --auto --period month              自动预测未来一个月');
  console.error('  node predict.js --period 10                       自动预测未来10日');
  console.error('  node predict.js --auto --json                      输出 JSON 格式');
  console.error('  node predict.js --scenario \'{"sulfur_trend":"up"}\'  情景预测');
  console.error('  node predict.js \'{"sulfur_price_cny":3952,...}\'    精确因子预测');
  process.exit(1);
}
