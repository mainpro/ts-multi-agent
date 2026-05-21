---
name: sulfuric-acid-price-prediction
description: >
  基于42因子五维预测模型的华中市场98%工业硫酸价格分析与预测。
  预测未来5-20个交易日的出厂价区间和趋势走势。
  数据源：references/training-data.md 内嵌 871 条日度历史CSV数据（动态加载，非写死）。
  CLI 支持 --auto 自动从历史数据推断趋势并预测，无需手动输入数据。
  触发词：硫酸价格预测、硫酸行情、硫酸走势、sulfuric acid price forecast、
  帮我算硫酸价格、硫酸未来走势、硫磺酸价格预测。
metadata:
  systemName: 硫酸价格预测
  keywords:
    - 硫酸价格
    - 硫酸行情
    - 硫酸走势
    - 硫酸价格预测
    - sulfuric acid
    - 硫磺酸价格
allowedTools:
  - bash
  - read
  - glob
  - grep
  - conversation-get
---

# 预测流程

## A. CLI 快速预测

在项目根目录执行：

```bash
node skills/sulfuric-acid-price-prediction/scripts/predict.js
```

默认输出 JSON。如需文本表格格式加 `--text`。

| 场景 | 参数 |
|:---|:---|
| 未来一个月（20天） | `--period month` |
| 假设硫磺涨价 | `--scenario '{"sulfur_trend":"up"}'` |
| 假设硫磺跌价 | `--scenario '{"sulfur_trend":"down"}'` |
| 假设政策收紧 | `--scenario '{"policy":"0.9"}'` |
| 假设政策放松 | `--scenario '{"policy":"0.1"}'` |

## B. LLM 代理指令（作为 AI Agent 技能调用时使用）

当此技能作为 AI Agent 的预测工具被调用时，遵循以下指令：

### 输入格式

```json
{
  "task": "predict_sulfuric_acid_price",
  "horizon_days": 7,
  "base_date": "2026-05-20",
  "historical_data": "[CSV数据路径或内嵌内容]",
  "future_scenarios": {
    "sulfur_price_trend": "stable/high/low",
    "policy_intervention": 0.0-1.0,
    "seasonal_factor": "spring/summer/autumn/winter",
    "special_events": ["maintenance_season", "export_boom", "policy_meeting"]
  }
}
```

### 输出格式

```json
{
  "prediction_date": "2026-05-27",
  "base_date": "2026-05-20",
  "current_spot_price": 700.0,
  "predicted_price": { "low": 680.0, "mid": 710.0, "high": 740.0 },
  "raw_predicted_price": 276.17,
  "clamped_to_range": [700, 1200],
  "confidence": "中",
  "key_drivers": [
    {"factor": "sulfur_price_cny", "impact": "+120", "reason": "硫磺维持高位，成本支撑强"},
    {"factor": "inventory", "impact": "-30", "reason": "库存远超正常水平，供需宽松"},
    {"factor": "policy_intervention", "impact": "-50", "reason": "保供稳价政策持续"}
  ],
  "risk_factors": ["硫磺进口到港延迟", "下游磷肥企业集中采购", "冶炼酸装置意外检修"],
  "logic_chain": "硫磺高位→成本基准→库存过剩→供需折价→政策压制→预测结果",
  "driver_analysis": "成本端：硫磺...元/吨处于高位...\n供需端：社会库存...万吨（严重过剩）...\n季节性：...月（...）...\n政策端：政策干预...（强干预）..."
}
```

### 输出要求（重要）

1. **展示无约束值**：输出表格中必须包含 `raw_predicted_price`（无约束真实预测值）列。当 `raw_predicted_price !== mid` 时，说明模型原始值被年份区间截断，需要在输出中明确标注。
2. **解释截断原因**：当所有预测日期的中值相同时（如全部为700），必须在输出中解释原因——说明无约束值低于/高于年份区间 `[下限, 上限]`，所有预测均被拦截至边界值。
3. **显示无约束趋势**：展示无约束值在预测期内的变动方向（如 `276→286，+10元`），反映模型的真实判断方向，避免被截断值掩盖。
4. **指标定义**：在输出中附带说明：
   - 预测中值（mid）：经年份区间约束的最终预测价格
   - 无约束值（raw_predicted_price）：模型原始计算值，未被截断
   - 价格区间 [low, high]：中值 ±37.5 元的置信区间
   - 置信度：高(|供需溢价|<50) / 中(|供需溢价|<100) / 低(≥100)
5. **成本倒挂提示**：当 `spot_price < cost_sulfur_acid - 100` 时（当前为亏损状态），必须在输出中提示成本倒挂风险。

### 关键判断规则

1. **成本倒挂**：`spot < cost_sulfur - 100` → 亏损→开工率7-14天降5-15%；`spot > cost_sulfur + 300` → 暴利→新增产能加速
2. **库存-价格联动**：<180万吨紧张周涨>50元；180-220平衡；>250宽松周跌>30元
3. **季节性规律**：1-2月冬储+20~50；3-5月春耕旺季+50~150；6-8月淡季±30；9-10月秋播+30~80；11-12月冬储+20~60
4. **政策干预**：`policy_intervention > 0.5` → 出口受限30-50%，价格回调50-100元
5. **新能源趋势**：`demand_lifepo4`环比>10% → 长期需求中枢年上移2-3%

### 异常情景处理

| 情景 | 识别条件 | 应对策略 |
|:---|:---|:---|
| 成本倒挂 | spot < cost_sulfur - 100 | 预测短期反弹，但中期产能退出 |
| 极端天气 | weather_factor > 0.9 | 运输受阻，区域价差扩大 |
| 政策突变 | policy_intervention 从0→0.8 | 立即锁定价格上限，忽略成本支撑 |
| 出口暴增 | export环比+50% | 国内供应紧张，价格跳涨 |
| 硫磺断供 | sulfur_import < 1万吨/日 | 成本失控，价格跟随硫磺暴涨 |
| 下游崩盘 | downstream_utilization < 60% | 需求崩塌，价格跌破成本线 |

### 预测准确性自检清单

- [ ] 预测价格是否高于综合生产成本？（正常应高50-200元）
- [ ] 库存变化方向与价格变化方向是否相反？（库存↑→价格↓）
- [ ] 硫磺价格变化与硫酸价格变化是否同向？（同向，滞后3-7天）
- [ ] 春耕季预测是否高于淡季？（3-5月应高于7-8月）
- [ ] 出口大增时国内价格是否更紧张？（出口↑→国内价格↑）
- [ ] 政策干预期是否价格涨幅受限？（policy_intervention高→价格上限）
- [ ] 冶炼酸大量供应时是否压制硫磺酸价格？（冶炼酸占比↑→价格天花板↓）

### 市场逻辑链（供推理参考）

1. **硫磺→成本→价格底线**：国际硫磺短缺→进口价↑→制酸成本↑→利润倒挂→供应收缩→价格被迫跟涨
2. **春耕→磷肥→季节性溢价**：粮价↑→春耕备肥→磷肥开工率↑→硫酸采购↑→库存低位则季节性上涨
3. **新能源→磷酸铁锂→需求结构**：磷酸铁锂产能扩张→净化磷酸需求↑→硫酸需求增量→长期中枢上移
4. **冶炼酸→价格天花板**：铜锌价↑→矿山增产→冶炼副产硫酸↑→下游转向冶炼酸→硫磺酸承压
5. **政策干预→价格修正**：硫酸暴涨→磷肥成本失控→粮食安全受威胁→限出口+限价→短期回调


