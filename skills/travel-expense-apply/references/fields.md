# 字段清单和层级关系

## 一、必填字段清单

### 1.1 所有必填字段（共 30 个）

| 字段名 | 类型 | 来源 | 描述 |
|--------|------|------|------|
| orderType | String | 固定值 | 单据类型，固定 `"sqcl"` |
| approvalStatus | String | 固定值 | 审批状态，固定 `"sp"` |
| exchangeRate | Double | 固定值 | 汇率，固定 `1` |
| localCurrency | Double | 计算值 | 本币金额 = originalCoin |
| applyBy | Long | 接口 | 申请人ID |
| applyCode | String | 接口 | 申请人编码 |
| applyName | String | 接口 | 申请人名称 |
| applyOrgId | Long | 接口 | 申请人所属部门ID |
| applyOrgCode | String | 接口 | 申请人所属部门编码 |
| applyOrgName | String | 接口 | 申请人所属部门名称 |
| costOrgId | Long | 接口+选择 | 预算占用部门ID |
| costOrgCode | String | 接口+选择 | 预算占用部门编码 |
| costOrgName | String | 接口+选择 | 预算占用部门名称 |
| enterpriseId | Long | 接口+选择 | 法人公司ID |
| enterpriseCode | String | 接口+选择 | 法人公司编码 |
| enterpriseName | String | 接口+选择 | 法人公司名称 |
| costCenterId | Long | 接口+选择 | 成本中心ID |
| costCenterCode | String | 接口+选择 | 成本中心编码 |
| costCenterName | String | 接口+选择 | 成本中心名称 |
| costId | Long | 接口+选择 | 费用项目ID |
| costCode | String | 接口+选择 | 费用项目编码 |
| costName | String | 接口+选择 | 费用项目名称 |
| currencyId | Long | 接口+选择 | 币种ID |
| currencyCode | String | 接口+选择 | 币种编码 |
| currencyName | String | 接口+选择 | 币种名称 |
| originalCoin | Double | 用户输入 | 申请金额 |
| remark | String | 用户输入 | 业务描述 |
| travelStartDate | String | 用户输入 | 出差开始时间 (yyyy-MM-dd) |
| travelEndDate | String | 用户输入 | 出差结束时间 (yyyy-MM-dd) |
| travelRange | Integer | 用户输入 | 出差范围: 3=国内, 4=国际, 5=港澳台 |
| areasPOS | List | 接口+选择 | 出差地点列表 |
| associatePOS | List | 接口+选择 | 同行人员列表（可为空） |

### 1.2 固定值字段（无需收集）

```json
{
  "orderType": "sqcl",
  "approvalStatus": "sp",
  "exchangeRate": 1,
  "localCurrency": "<same as originalCoin>"
}
```

---

## 二、字段层级关系（级联依赖）

```
第0层：用户身份
├── userId (用户输入/上下文获取)
│
├── 第1层：通过 userId 获取
│   └── applyBy, applyCode, applyName, applyOrgId, applyOrgCode, applyOrgName
│       └── 接口: searchApplyUserListNew(userId) → 选择申请人
│
├── 第2层：通过 userId 获取
│   └── costOrgId, costOrgCode, costOrgName
│       └── 接口: searchCostOrganizationByUserId(userId) → 选择预算部门
│
├── 第3层：通过 costOrgId 获取
│   └── enterpriseId, enterpriseCode, enterpriseName
│       └── 接口: searchEnterpriseByOrgId(costOrgId) → 选择法人公司
│
├── 第4层：通过 costOrgId 和 enterpriseId 获取
│   └── costCenterId, costCenterCode, costCenterName
│       └── 接口: searchCostCenterListByEnterpriseIdAndOrgId(enterpriseId, costOrgId) → 选择成本中心
│
├── 第5层：通过 costCenterId 获取
│   └── costId, costCode, costName
│       └── 接口: searchCostItemByOrgAndResourcePage(costCenterId) → 选择费用项目
│
├── 第6层：独立数据源
│   ├── currencyId, currencyCode, currencyName
│   │   └── 接口: searchCurrencyList() → 选择币种
│   │
│   ├── areasPOS
│   │   └── 接口: seachAreasList(城市名) → 选择出差地点
│   │
│   └── associatePOS
│       └── 接口: searchUserList(姓名) → 选择同行人员
│
└── 第7层：用户直接输入
    ├── originalCoin (申请金额)
    ├── remark (业务描述)
    ├── travelStartDate (出差开始时间)
    ├── travelEndDate (出差结束时间)
    └── travelRange (出差范围)
```

### 2.1 级联依赖关系表

| 子字段 | 依赖字段 | 依赖接口 |
|--------|----------|----------|
| applyBy 等 | userId | searchApplyUserListNew |
| costOrgId 等 | userId | searchCostOrganizationByUserId |
| enterpriseId 等 | costOrgId | searchEnterpriseByOrgId |
| costCenterId 等 | costOrgId, enterpriseId | searchCostCenterListByEnterpriseIdAndOrgId |
| costId 等 | costCenterId | searchCostItemByOrgAndResourcePage |
| currencyId 等 | 无 | searchCurrencyList |
| areasPOS | 无（用户输入城市名） | seachAreasList |
| associatePOS | 无（用户输入姓名） | searchUserList |

### 2.2 关键字段变化触发重新获取

| 关键字段变化 | 需要重新获取的字段 | 需要清除的缓存 |
|--------------|-------------------|----------------|
| userId | applyBy, costOrgId, 及其所有下级字段 | applyUserList, costOrgList, enterpriseList_*, costCenterList_*, costItemList_* |
| costOrgId | enterpriseId, costCenterId, costId | enterpriseList_*, costCenterList_*, costItemList_* |
| enterpriseId | costCenterId, costId | costCenterList_*, costItemList_* |
| costCenterId | costId | costItemList_* |

---

## 三、字段收集策略

### 3.1 快速模式：自然语言提取规则

| 信息类型 | 解析规则 | 示例 |
|----------|----------|------|
| 出差时间 | 解析日期范围，支持多种格式 | "下周三去上海" → 2026-04-22<br>"4月20日到22日" → 2026-04-20 ~ 2026-04-22<br>"5.1到5.3" → 2026-05-01 ~ 2026-05-03 |
| 出差地点 | 提取城市名 | "去上海出差" → 上海<br>"北京和广州" → 北京, 广州 |
| 申请金额 | 提取数字，支持单位 | "3000元" → 3000<br>"5000块" → 5000<br>"2000美元" → 2000 |
| 预算部门 | 提取部门名称 | "财务科" → 财务科<br>"信息部" → 信息部 |
| 法人公司 | 提取公司名称 | "金宏集团" → 金宏集团<br>"科技公司" → 科技公司 |
| 成本中心 | 提取成本中心名称 | "研发中心" → 研发中心<br>"市场部" → 市场部 |
| 费用项目 | 提取费用项目名称 | "差旅费" → 差旅费<br>"交通费" → 交通费 |
| 业务描述 | 提取描述内容 | "去上海洽谈业务" → 去上海洽谈业务<br>"参加技术培训" → 参加技术培训 |
| 出差范围 | 关键词匹配 | "国内"→3, "国际"→4, "港澳台"→5<br>"出国"→4, "境外"→4 |
| 币种 | 关键词匹配 | "人民币" → 人民币<br>"美元" → 美元<br>"欧元" → 欧元 |
| 同行人员 | 提取姓名列表 | "和张三一起" → 张三<br>"张三、李四" → 张三、李四 |

### 3.2 引导模式：用户输入解析规则

| 信息类型 | 解析规则 | 示例 |
|----------|----------|------|
| 预算占用部门 | 匹配 costOrgList 中的 orgName | "财务科" → costOrgId |
| 法人公司 | 匹配 enterpriseList 中的 enterpriseName | "XX公司" → enterpriseId |
| 成本中心 | 匹配 costCenterList 中的 costCenterName | "研发中心" → costCenterId |
| 费用项目 | 匹配 costItemList 中的 costName | "差旅费" → costId |
| 出差时间 | 解析日期范围 | "4月20日到22日" → 2026-04-20 ~ 2026-04-22 |
| 出差范围 | 关键词匹配 | "国内"→3, "国际"→4, "港澳台"→5 |
| 出差地点 | 城市名 | "上海" → 调用地点接口匹配 |
| 申请金额 | 数字提取 | "3000块" → 3000 |
| 币种 | 匹配 currencyList | "人民币" → currencyId |
| 业务描述 | 直接提取 | "去上海出差" → remark |
| 同行人员 | 姓名列表 | "张三、李四" → 调用人员接口匹配 |

### 3.3 缺失字段提示

当缺少必填字段时，按优先级提示用户：

```
缺少 [字段名]，请提供以下信息：
- 预算占用部门：[展示可选列表]
- 法人公司：[展示可选列表]
...
```

---

## 四、完整示例

### 示例1：快速模式 - 用户提供关键信息

**用户输入：**
```
userId=1727596139882397698，帮我申请差旅，下周三去上海出差，3000元，财务科
```

**执行流程：**
1. 解析 userId → 1727596139882397698
2. 智能解析：
   - 出差时间：下周三 → 2026-04-22
   - 出差地点：上海
   - 申请金额：3000元 → 3000
   - 预算部门：财务科
3. 调用接口获取：
   - 申请人列表 → 选择第一个（张三）
   - 预算部门列表 → 匹配"财务科" → costOrgId
   - 法人公司列表 → 选择第一个（金宏集团）
   - 成本中心列表 → 选择第一个（研发中心）
   - 费用项目列表 → 选择第一个（差旅费）
   - 币种列表 → 选择人民币
4. 生成确认清单：
```
请确认以下信息是否正确：

1. 申请人：张三 (id:1727596139882397698)
2. 预算部门：财务科 (id:1727507556643364900)
3. 法人公司：金宏集团 (id:1730125261242494978)
4. 成本中心：研发中心 (id:123456789)
5. 费用项目：差旅费 (id:987654321)
6. 币种：人民币 (id:1)
7. 出差地点：上海
8. 出差时间：2026-04-22 至 2026-04-23（默认1天）
9. 申请金额：3000 元
10. 业务描述：去上海出差
11. 出差范围：国内

以上信息是否正确？如果有需要修改的地方，请告诉我具体修改内容。
```
5. 用户确认："正确"
6. 调用保存接口完成申请

### 示例2：快速模式 - 用户修改部分信息

**用户输入：**
```
时间改成4月25日到28日，金额改成5000元
```

**执行流程：**
1. 解析修改内容：
   - 出差时间：4月25日到28日 → 2026-04-25 ~ 2026-04-28
   - 申请金额：5000元 → 5000
2. 更新字段值
3. 生成新的确认清单
4. 用户确认后调用保存接口

### 示例3：引导模式 - 渐进式收集

**用户输入：**
```
帮我申请差旅
```

**执行流程：**
1. 检查 userId → 未找到
2. 提示："请问您的 userId 是多少？"

**用户输入：**
```
1727596139882397698
```

**执行流程：**
1. 调用接口获取申请人列表
2. 申请人有多个 → 展示列表让用户选择
3. 提示："请选择申请人：1. 张三  2. 李四"

**用户输入：**
```
张三
```

**执行流程：**
1. 调用接口获取预算部门列表
2. 预算部门有多个 → 展示列表让用户选择
3. 提示："请选择预算占用部门：1. 财务科  2. 信息部"

**用户输入：**
```
信息部
```

**执行流程：**
1. 调用接口获取法人公司
2. ...继续收集其他字段
