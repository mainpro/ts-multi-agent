# 硫酸价格预测 - 42因子详细计算规则

> 基于五维因子模型：成本端 + 供应端 + 需求端 + 政策宏观 + 关联端
> 输出：价格区间 [low, mid, high] + 置信度 + 关键驱动因子

## 一、五维因子总览

```
┌─────────────────────────────────────────────────────────────┐
│                    硫酸价格预测五维模型                        │
├─────────────┬─────────────┬─────────────┬─────────────┬───────┤
│   成本端     │   供应端     │   需求端     │   政策/宏观  │ 关联端 │
│  (9个因子)   │  (10个因子)  │  (7个因子)   │  (8个因子)   │(8个因子)│
└─────────────┴─────────────┴─────────────┴─────────────┴───────┘
```

## 二、成本端因子（9个）— 价格底部支撑

### 2.1 硫磺价格 ⭐⭐⭐⭐⭐（核心）
| 字段 | 含义 | 单位 |
|:---|:---|:---|
| `sulfur_price_cny` | 硫磺价格(人民币) | 元/吨 |
| `sulfur_price_usd` | 硫磺价格(美元) | 美元/吨 |

**硫磺制酸成本公式**：
```
cost_sulfur_acid = sulfur_price_cny × 0.35 + 200 + electricity_cost × 220
```
吨酸硫磺单耗 0.35，吨酸电耗 220 度。综合成本权重 45%。

### 2.2 冶炼酸成本
| 字段 | 含义 | 单位 |
|:---|:---|:---|
| `metal_price_cu_zn` | 铜锌金属价格 | 元/吨 |

**公式**：`cost_smelting_acid = MAX(150, metal_price_cu_zn × 0.002 + 80)`
副产品，成本最低。综合成本权重 40%。

### 2.3 硫铁矿制酸成本
| 字段 | 含义 | 单位 |
|:---|:---|:---|
| `pyrite_price` | 硫铁矿价格 | 元/吨 |

**公式**：`cost_pyrite_acid = pyrite_price × 0.42 + 180 + electricity_cost × 280`
综合成本权重 15%。

### 2.4 加权综合生产成本
```
production_cost_weighted = cost_sulfur_acid × 0.45 + cost_smelting_acid × 0.40 + cost_pyrite_acid × 0.15
```

### 2.5 能源与物流
| 字段 | 含义 | 单位 | 说明 |
|:---|:---|:---|:---|
| `crude_oil_usd` | 原油价格 | 美元/桶 | 影响运输和蒸汽成本 |
| `electricity_cost` | 电价 | 元/度 | 吨酸耗电220-280度 |
| `steam_cost` | 蒸汽成本 | 元/吨 | 副产蒸汽可抵扣成本 |
| `shipping_index` | 运价指数 | 点 | 硫酸运输半径300-500km |
| `exchange_rate` | 汇率 | - | 影响进口硫磺到岸价 |

## 三、供应端因子（10个）— 价格弹性来源

### 3.1 产量与产能
| 字段 | 含义 | 单位 | 公式 |
|:---|:---|:---|:---|
| `production_total` | 硫酸总产量 | 万吨/日 | 年度产能/365 × 产能利用率 |
| `capacity_utilization` | 产能利用率 | % | BASE(75%) + 季节±8% + 利润响应 + 环保-10% |
| `new_capacity` | 新增产能 | 万吨/日 | 当年投产产能/365 |
| `maintenance_loss` | 检修损失量 | 万吨/日 | 春秋两季集中检修 |

### 3.2 库存 ⭐⭐⭐⭐⭐
| 字段 | 含义 | 单位 |
|:---|:---|:---|
| `inventory` | 社会库存 | 万吨 |

**库存-价格公式**：
```
inventory_premium = (200 - inventory) / 50 × 30
```
- 库存 < 180 万吨 → 紧张，周涨 > 50 元
- 180~220 万吨 → 平衡
- > 250 万吨 → 宽松，周跌 > 30 元

### 3.3 进出口
| 字段 | 含义 | 单位 | 说明 |
|:---|:---|:---|:---|
| `sulfur_import` | 硫磺进口量 | 万吨/日 | 国内50%依赖进口 |
| `sulfur_export` | 硫磺出口量 | 万吨/日 | 俄罗斯出口量是关键变量 |
| `sulfuric_acid_import` | 硫酸进口量 | 万吨/日 | 可忽略(<1%) |
| `sulfuric_acid_export` | 硫酸出口量 | 万吨/日 | 2025年出口分流国内资源 |

### 3.4 环保限产
| 字段 | 含义 | 单位 |
|:---|:---|:---|
| `env_restriction` | 环保限产指数 | 0-1 |

**公式**：`production_total = nominal_production × (1 - env_restriction × 0.15)`

## 四、需求端因子（7个）— 价格顶部压力

### 4.1 下游需求结构
| 字段 | 含义 | 占比 | 特征 |
|:---|:---|:---:|:---|
| `demand_fertilizer` | 磷肥需求 | ~51% | 春耕刚性需求，粮价敏感 |
| `demand_tio2` | 钛白粉需求 | ~13.4% | 房地产+涂料，硫酸法占85% |
| `demand_caprolactam` | 己内酰胺需求 | ~6.5% | 尼龙原料，纺织周期 |
| `demand_hf` | 氢氟酸需求 | ~5% | 新能源+半导体 |
| `demand_lifepo4` | 磷酸铁锂需求 | 快速增长 | 新能源增量 |
| `total_demand` | 总需求(含出口) | 100% | = 各下游 + 出口 |
| `downstream_utilization` | 下游开工率 | % | 综合下游景气度 |

### 4.2 总需求公式
```
total_demand = demand_fertilizer + demand_tio2 + demand_caprolactam + demand_hf + demand_lifepo4 + sulfuric_acid_export
```

## 五、政策与宏观因子（8个）

| 字段 | 含义 | 单位 | 影响 |
|:---|:---|:---|:---|
| `policy_intervention` | 政策干预指数 ⭐⭐⭐⭐ | 0-1 | -80 × policy，保供稳价压制 |
| `weather_factor` | 天气因子 | 0-1 | 影响春耕和运输 |
| `grain_price_index` | 粮食价格指数 | 点 | 粮价高→化肥需求↑ |
| `spot_price_huazhong` | 华中现货价格 | 元/吨 | **目标预测变量** |
| `fertilizer_price` | 磷肥价格 | 元/吨 | = 2800 + spot × 0.8 |
| `tio2_price` | 钛白粉价格 | 元/吨 | = 14500 + spot × 1.2 |
| `map_price` | 磷酸一铵价格 | 元/吨 | 磷肥细分品种 |
| `dap_price` | 磷酸二铵价格 | 元/吨 | 磷肥细分品种 |

## 六、关联端因子（8个）

| 字段 | 含义 | 单位 | 说明 |
|:---|:---|:---|:---|
| `phosphate_rock_price` | 磷矿石价格 | 元/吨 | 磷肥原料 |
| `fluorite_price` | 萤石价格 | 元/吨 | 氢氟酸原料 |
| `ammonia_price` | 合成氨价格 | 元/吨 | 磷肥原料 |
| `sulfur_net` | 硫磺净进口 | 万吨/日 | import - export |
| `cost_sulfur_acid` | 硫磺制酸成本 | 元/吨 | = sulfur_price × 0.35 + 200 + elec × 220 |
| `cost_smelting_acid` | 冶炼酸成本 | 元/吨 | = MAX(150, metal × 0.002 + 80) |
| `cost_pyrite_acid` | 硫铁矿制酸成本 | 元/吨 | = pyrite × 0.42 + 180 + elec × 280 |
| `production_cost_weighted` | 综合生产成本 | 元/吨 | 加权平均 |

## 七、核心预测公式

### 步骤1：成本基准
```
cost_base = cost_sulfur_acid × 0.45 + cost_smelting_acid × 0.40 + cost_pyrite_acid × 0.15
```

### 步骤2：供需溢价
```
inventory_premium = (200 - inventory) / 50 × 30
gap = production_total - total_demand
gap_premium = -gap × 15
util_premium = (capacity_utilization - 75) × 0.5
maint_premium = -maintenance_loss × 20
newcap_premium = -new_capacity × 5000
sd_premium = inventory_premium + gap_premium + util_premium + maint_premium + newcap_premium
```

### 步骤3：季节性调整
```
seasonal = sin(2π × day_of_year / 365 - π/6) × 40 + weather_factor × 20
```

### 步骤4：政策宏观调整
```
policy_adj = -80 × policy_intervention
env_premium = -env_restriction × 30
export_premium = sulfuric_acid_export × 10
sulfur_net = sulfur_import - sulfur_export
sulfur_premium = -sulfur_net × 5
downstream_premium = downstream_utilization × 2
policy_macro = policy_adj + env_premium + export_premium + sulfur_premium + downstream_premium
```

### 步骤5：综合预测
```
predicted = cost_base + sd_premium + seasonal + policy_macro
```

### 步骤6：年份约束
| 年份 | 价格区间 |
|:---|:---|
| 2024 | [280, 650] |
| 2025 | [400, 1300] |
| 2026 | [700, 1200] |

### 步骤7：置信度
```
if abs(sd_premium) < 50 → 高
if abs(sd_premium) < 100 → 中
else → 低
```

## 八、季节因子速查

| 月份 | 季节性 | spring_flag | 核心事件 |
|:---:|:---|:---:|:---|
| 1月 | +20~50 冬储 | 0 | 备货 |
| 2月 | +20~50 | 1 | 春耕备肥 |
| 3月 | +50~150 春耕旺季 | 1 | 旺季 |
| 4月 | +50~150 | 1 | 旺季尾声 |
| 5月 | +20~50 | 0 | 春耕结束 |
| 6月 | ±30 淡季 | 0 | 夏季检修 |
| 7月 | ±30 | 0 | 淡季 |
| 8月 | ±30 | 0 | 淡季 |
| 9月 | +30~80 秋播 | 0 | 秋播备肥 |
| 10月 | +30~80 | 0 | 秋播 |
| 11月 | +20~60 冬储 | 0 | 冬储 |
| 12月 | +20~60 | 0 | 冬储+出口 |

## 九、关键判断规则

### 成本倒挂
- `spot_price < cost_sulfur_acid - 100` → 亏损 → 开工率7-14天内降5-15%
- `spot_price > cost_sulfur_acid + 300` → 暴利 → 新增产能加速

### 库存-价格联动
- `< 180万吨` → 紧张，周涨 > 50元
- `180-220万吨` → 平衡
- `> 250万吨` → 宽松，周跌 > 30元

### 政策干预
- `policy_intervention > 0.5` → 出口受限30-50%，价格回调50-100元

### 新能源需求
- `demand_lifepo4` 环比 > 10% → 长期需求中枢年上移2-3%

## 字段释义（对应CSV 42因子）

### 成本端（9个）
| 字段名 | 中文名 | 单位 |
|:---|:---|:---|
| `sulfur_price_cny` | 硫磺价格(人民币) | 元/吨 |
| `sulfur_price_usd` | 硫磺价格(美元) | 美元/吨 |
| `pyrite_price` | 硫铁矿价格 | 元/吨 |
| `metal_price_cu_zn` | 铜锌金属价格 | 元/吨 |
| `crude_oil_usd` | 原油价格 | 美元/桶 |
| `exchange_rate` | 美元兑人民币汇率 | - |
| `shipping_index` | 运价指数 | 点 |
| `electricity_cost` | 电价 | 元/度 |
| `steam_cost` | 蒸汽成本 | 元/吨 |

### 供应端（10个）
| 字段名 | 中文名 | 单位 |
|:---|:---|:---|
| `sulfur_import` | 硫磺进口量 | 万吨/日 |
| `sulfur_export` | 硫磺出口量 | 万吨/日 |
| `sulfuric_acid_import` | 硫酸进口量 | 万吨/日 |
| `sulfuric_acid_export` | 硫酸出口量 | 万吨/日 |
| `production_total` | 硫酸总产量 | 万吨/日 |
| `capacity_utilization` | 产能利用率 | % |
| `maintenance_loss` | 检修损失量 | 万吨/日 |
| `new_capacity` | 新增产能 | 万吨/日 |
| `inventory` | 社会库存 | 万吨 |
| `env_restriction` | 环保限产指数 | 0-1 |

### 需求端（7个）
| 字段名 | 中文名 | 单位 |
|:---|:---|:---|
| `demand_fertilizer` | 磷肥需求 | 万吨/日 |
| `demand_tio2` | 钛白粉需求 | 万吨/日 |
| `demand_caprolactam` | 己内酰胺需求 | 万吨/日 |
| `demand_hf` | 氢氟酸需求 | 万吨/日 |
| `demand_lifepo4` | 磷酸铁锂需求 | 万吨/日 |
| `total_demand` | 总需求(含出口) | 万吨/日 |
| `downstream_utilization` | 下游开工率 | % |

### 价格与利润（9个）
| 字段名 | 中文名 | 单位 |
|:---|:---|:---|
| `cost_sulfur_acid` | 硫磺制酸成本 | 元/吨 |
| `cost_smelting_acid` | 冶炼酸成本 | 元/吨 |
| `cost_pyrite_acid` | 硫铁矿制酸成本 | 元/吨 |
| `production_cost_weighted` | 综合生产成本 | 元/吨 |
| `spot_price_huazhong` | **华中现货价格（目标变量）** | 元/吨 |
| `fertilizer_price` | 磷肥价格 | 元/吨 |
| `tio2_price` | 钛白粉价格 | 元/吨 |
| `map_price` | 磷酸一铵价格 | 元/吨 |
| `dap_price` | 磷酸二铵价格 | 元/吨 |

### 关联原料与宏观（7个）
| 字段名 | 中文名 | 单位 |
|:---|:---|:---|
| `phosphate_rock_price` | 磷矿石价格 | 元/吨 |
| `fluorite_price` | 萤石价格 | 元/吨 |
| `ammonia_price` | 合成氨价格 | 元/吨 |
| `grain_price_index` | 粮食价格指数 | 点 |
| `weather_factor` | 天气因子 | 0-1 |
| `policy_intervention` | 政策干预指数 | 0-1 |

## 关键因子档位速查

| 因子 | 条件 | 结论 |
|:---|:---|:---|
| 库存 | < 180万吨 | 紧张，周涨 > 50元 |
| | 180~220万吨 | 平衡，价格跟随成本波动 |
| | > 250万吨 | 宽松，周跌 > 30元 |
| 产能利用率 | < 65% | 供应偏紧，价格获支撑 |
| | 65~75% | 平衡区间 |
| | > 80% | 供应充裕，价格承压 |
| 硫磺价格 | < 2000元/吨 | 低位，成本支撑弱 |
| | 2000~3500元/吨 | 中位，正常区间 |
| | > 3500元/吨 | 高位，成本支撑强劲 |
| 政策干预 | < 0.2 | 弱干预，市场自由运行 |
| | 0.2~0.5 | 中等干预，部分管控 |
| | > 0.5 | 强干预，出口受限/限价 |
| 下游开工率 | > 75% | 需求旺盛，采购积极 |
| | 60~75% | 正常水平 |
| | < 60% | 需求疲软，压价采购 |

## 智能体预测配置（五维42因子模型）

```json
{
  "product": "98%工业硫酸",
  "target_price": "华中市场出厂价",
  "predict_cycle": "5~20日滚动预测",
  "model": "五维因子模型（成本+供应+需求+政策宏观+关联端）",
  "core_formula": "PREDICTED = COST_BASE + SD_PREMIUM + SEASONAL + POLICY_MACRO",
  "dimensions": {
    "cost": {"weight": "基准", "key_fields": ["sulfur_price_cny", "metal_price_cu_zn", "pyrite_price", "electricity_cost"]},
    "supply_demand": {"weight": "溢价/折价", "key_fields": ["inventory", "production_total", "total_demand", "capacity_utilization", "maintenance_loss", "new_capacity"]},
    "seasonal": {"weight": "调整项", "key_fields": ["weather_factor"], "rule": "正弦周期 + 天气扰动"},
    "policy_macro": {"weight": "调整项", "key_fields": ["policy_intervention", "env_restriction", "sulfuric_acid_export", "sulfur_import", "sulfur_export", "downstream_utilization"]},
    "correlated": {"weight": "交叉验证", "key_fields": ["fertilizer_price", "tio2_price", "map_price", "dap_price", "phosphate_rock_price", "ammonia_price"]}
  },
  "year_ranges": {"2024": [280, 650], "2025": [400, 1300], "2026": [700, 1200]},
  "calculation_order": ["加载42因子数据", "计算成本基准", "计算供需溢价", "计算季节调整", "计算政策宏观", "汇总预测", "年份区间约束", "输出[low,mid,high]区间"],
  "output_schema": {
    "predicted_price": {"low": "区间下限", "mid": "预测中值", "high": "区间上限"},
    "break_down": {"cost_base": "成本基准", "sd_premium": "供需溢价", "seasonal": "季节性", "policy_macro": "政策宏观"},
    "confidence": "高/中/低",
    "driver_analysis": "动因分析文本"
  }
}
```

## Demo 实测样例

### 输入数据（2026-05-15）

```json
{
  "sulfur_price_cny": 3952,
  "inventory": 1471,
  "capacity_utilization": 83.3,
  "production_total": 32.3,
  "total_demand": 30.4,
  "maintenance_loss": 0.3,
  "new_capacity": 0.005,
  "policy_intervention": 0.8,
  "env_restriction": 0.3,
  "sulfuric_acid_export": 1.0,
  "sulfur_import": 3.0,
  "sulfur_export": 0.5,
  "downstream_utilization": 78,
  "weather_factor": 0.5,
  "metal_price_cu_zn": 65000,
  "pyrite_price": 600,
  "electricity_cost": 0.62,
  "spot_price_huazhong": 700
}
```

### 预期输出样式（验证用）

```plain
【硫酸98%华中出厂价预测】
日期：2026-05-15
当前现货价：700 元/吨
预测价格：... 元/吨  区间 [..., ...]  置信度：...

成本基准：...  供需溢价：...
季节性：...  政策宏观：...

【动因分析】
成本端：硫磺3952元/吨处于高位，硫磺制酸成本...元/吨，综合成本基准...元/吨
供需端：库存1471万吨（严重过剩），供大于求...
季节性：5月（春耕尾声）...
政策端：政策干预0.8（强干预）...

核心驱动：...
趋势判断：...
```

> 注：实际预测值由 `scripts/predict.js` 根据当日完整42因子数据计算得出。
> 请使用 `--auto` 或 `--scenario` 模式获取最新预测结果。

---

## 附录A：基于CSV历史数据的因子推断方法

`scripts/predict.js` 的 `--auto` 模式实现了从历史数据到因子值的自动推断：

### A.1 数据加载

从 `references/training-data.md` 的 csv 代码块读取 871 条日度记录（2024-01-01 至 2026-05-20），每条记录包含全部 42 个因子字段。

### A.2 趋势推断

取最近 60 天数据，对每个关键因子计算 **简单线性回归**：

```
y = slope × x + intercept
```

其中 x = 天数偏移（0-59），y = 因子值。得到每个因子的 `slope`（日变化斜率）和 `last`（最新值）。

### A.3 因子投影

对预测期的每一天，按 `dayOffset`（距最新日期的天数偏移）对每个因子投影：

```
projected_value = trend.last + trend.slope × dayOffset
```

### A.4 日间演变修正（超越线性投影）

对于核心动态因子，不使用线性投影，而是通过 `evolveFactors` 函数进行因果递推：

| 因子 | 偏离简单投影 | 递推规则 |
|:---|:---|:---|
| `spot_price_huazhong` | 完全替代 | 前一日预测中值成为新的"当前现货价" |
| `inventory` | 修正 | `prev_inventory + (production - demand) × 0.3` |
| `capacity_utilization` | 条件修正 | 成本倒挂时降1%/天，暴利时升0.5%/天 |
| `total_demand` | 修正 | 价格每变动10%，需求反向变动1.5%（低弹性） |
| `sulfuric_acid_export` | 条件修正 | 政策 > 0.5 时出口逐日降5% |
| `maintenance_loss` | 条件修正 | 春/秋检修季 +0.1/天，非检修季 -0.05/天 |
| `weather_factor` | 修正 | 春季+0.02/天，夏季-0.01/天，秋季+0.005/天 |

### A.5 线性趋势覆盖的因子

以下因子在 auto 模式下使用纯线性趋势投影（无因果递推）：

sulfur_price_cny, sulfur_price_usd, pyrite_price, metal_price_cu_zn, crude_oil_usd,
exchange_rate, shipping_index, electricity_cost, steam_cost, sulfur_import,
sulfur_export, sulfuric_acid_import, production_total, new_capacity,
env_restriction, demand_fertilizer, demand_tio2, demand_caprolactam,
demand_hf, demand_lifepo4, downstream_utilization, fertilizer_price, tio2_price,
map_price, dap_price, phosphate_rock_price, fluorite_price, ammonia_price,
grain_price_index, policy_intervention
