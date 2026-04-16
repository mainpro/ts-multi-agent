# 字段清单和层级关系

## 一、必填字段清单

### 1.1 所有必填字段（共 27 个）

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
│   ├── applyBy, applyCode, applyName, applyOrgId, applyOrgCode, applyOrgName
│   │   └── 接口: searchApplyUserListNew(userId) → 选择申请人
│   │
│   └── costOrgId, costOrgCode, costOrgName
│       └── 接口: searchCostOrganizationByUserId(userId) → 选择预算部门
│
├── 第2层：通过 costOrgId 获取
│   ├── enterpriseId, enterpriseCode, enterpriseName
│   │   └── 接口: searchEnterpriseByOrgId(costOrgId) → 选择法人公司
│   │
│   └── costId, costCode, costName
│       └── 接口: searchCostItemByOrgAndResourcePage(costOrgId) → 选择费用项目
│
├── 第3层：独立数据源
│   ├── currencyId, currencyCode, currencyName
│   │   └── 接口: searchCurrencyList() → 选择币种
│   │
│   ├── areasPOS
│   │   └── 接口: seachAreasList(城市名) → 选择出差地点
│   │
│   └── associatePOS
│       └── 接口: searchUserList(姓名) → 选择同行人员
│
└── 第4层：用户直接输入
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
| costId 等 | costOrgId | searchCostItemByOrgAndResourcePage |
| currencyId 等 | 无 | searchCurrencyList |
| areasPOS | 无（用户输入城市名） | seachAreasList |
| associatePOS | 无（用户输入姓名） | searchUserList |

### 2.2 关键字段变化触发重新获取

| 关键字段变化 | 需要重新获取的字段 | 需要清除的缓存 |
|--------------|-------------------|----------------|
| userId | applyBy, costOrgId, 及其所有下级字段 | applyUserList, costOrgList, enterpriseList_*, costItemList_* |
| costOrgId | enterpriseId, costId | enterpriseList_*, costItemList_* |

---

## 三、字段收集策略

### 3.1 用户输入解析规则

| 信息类型 | 解析规则 | 示例 |
|----------|----------|------|
| 预算占用部门 | 匹配 costOrgList 中的 orgName | "财务科" → costOrgId |
| 法人公司 | 匹配 enterpriseList 中的 enterpriseName | "XX公司" → enterpriseId |
| 费用项目 | 匹配 costItemList 中的 costName | "差旅费" → costId |
| 出差时间 | 解析日期范围 | "4月20日到22日" → 2026-04-20 ~ 2026-04-22 |
| 出差范围 | 关键词匹配 | "国内"→3, "国际"→4, "港澳台"→5 |
| 出差地点 | 城市名 | "上海" → 调用地点接口匹配 |
| 申请金额 | 数字提取 | "3000块" → 3000 |
| 币种 | 匹配 currencyList | "人民币" → currencyId |
| 业务描述 | 直接提取 | "去上海出差" → remark |
| 同行人员 | 姓名列表 | "张三、李四" → 调用人员接口匹配 |

### 3.2 缺失字段提示

当缺少必填字段时，按优先级提示用户：

```
缺少 [字段名]，请提供以下信息：
- 预算占用部门：[展示可选列表]
- 法人公司：[展示可选列表]
...
```

---

## 四、完整示例

### 示例1：用户一次性提供所有信息

**用户输入：**
```
userId=1727596139882397698，帮我申请差旅，去上海出差，4月20日到22日，预算部门选财务科，法人公司选金宏集团，费用项目选差旅费，申请金额3000元，业务描述是去上海洽谈业务
```

**执行流程：**
1. 解析 userId → 1727596139882397698
2. 调用接口获取申请人列表、预算部门列表 → 缓存
3. 匹配"财务科" → costOrgId
4. 调用接口获取法人公司、费用项目 → 缓存
5. 匹配"金宏集团" → enterpriseId
6. 匹配"差旅费" → costId
7. 匹配"上海" → 调用地点接口 → areasPOS
8. 解析金额 → 3000
9. 解析时间 → 2026-04-20 ~ 2026-04-22
10. 解析描述 → "去上海洽谈业务"
11. 默认币种 → 人民币
12. 默认出差范围 → 国内
13. 调用保存接口

### 示例2：渐进式收集

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
1. 调用接口获取申请人列表、预算部门列表
2. 预算部门有多个 → 展示列表让用户选择
3. 提示："请选择预算占用部门：1. 财务科  2. 信息部"

**用户输入：**
```
信息部
```

**执行流程：**
1. 调用接口获取法人公司、费用项目
2. 法人公司有多个 → 展示列表让用户选择
3. ...继续收集其他字段
