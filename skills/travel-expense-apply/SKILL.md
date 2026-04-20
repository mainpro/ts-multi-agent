---
name: travel-expense-apply
description: 帮助用户创建差旅费用申请单。通过渐进式收集必填字段（申请人、预算部门、法人公司、费用项目、出差信息等），最终调用保存接口完成申请。当用户提到"差旅申请"、"出差申请"、"费用申请"时触发。
metadata:
  systemName: 差旅系统
  keywords:
    - 差旅申请
    - 出差费用
    - 差旅费用申请
    - 填出差单
    - 出差申请
    - travel apply
allowedTools:
  - bash
  - read
  - glob
  - grep
  - conversation-get
---

# 差旅费用申请单

帮助用户创建差旅费用申请单，支持两种交互模式：
- **快速模式**：用户一次性提供关键信息，系统智能解析并预测默认值，生成确认清单
- **引导模式**：系统一步步引导用户填写各个字段

## 交互模式选择与智能识别

### 智能模式识别

**当用户触发技能时**，系统会智能分析用户输入：

1. **如果用户直接提供出差信息**（包含时间、地点、金额、部门等关键信息），自动进入快速模式
2. **如果用户只说"申请差旅"等通用请求**，则询问用户选择模式

### 模式选择提示

当需要询问用户时，使用以下提示：

```
您好！我可以帮您申请差旅费用。您可以选择：

1. 快速模式（推荐）：直接告诉我出差相关信息，比如"下周三去上海出差，3000元，财务科"
2. 引导模式：我一步步引导您填写每个字段

请告诉我您想选择哪种模式？
```

### 快速模式智能识别规则

**自动进入快速模式的条件**：用户输入中包含以下信息中的至少3项：
- 出差时间（如"下周三"、"4月20日"、"5.1到5.3"）
- 出差地点（如"上海"、"北京"、"广州"）
- 申请金额（如"3000元"、"5000块"、"2000美元"）
- 预算部门（如"财务科"、"信息部"、"研发部"）
- 业务描述（如"去洽谈业务"、"参加培训"、"开会"）

**示例**：
- ✅ "下周三去上海出差，3000元，财务科" → 自动进入快速模式
- ✅ "4月20日到北京，5000元，信息部，参加培训" → 自动进入快速模式
- ❌ "帮我申请差旅" → 询问模式选择
- ❌ "我要申请出差" → 询问模式选择

## ⚠️ 关键规则（必须遵守）

1. **接口返回的是列表，每个元素包含 `id`、`code`、`name` 等字段。下游接口需要的是 `id` 字段，绝对不能使用 `code` 或 `name`**
2. **用户选择后，必须从接口返回数据中提取完整的 id/code/name 三元组，不能只记 name 忘记 id**
3. **提交时所有字段都必须有值，不能省略任何字段**
4. **⚠️ 展示选择列表时，必须把每个选项的 id 一并展示**（见下方「列表展示格式」），因为任务可能会暂停等待用户回复，恢复后需要从询问历史中获取 id，如果列表中没有 id，将无法继续执行

## 快速模式实现

### 1. 智能解析用户输入

**步骤1：智能模式识别**
- 分析用户输入，判断是否包含足够的出差信息
- 如果用户输入包含至少3项关键信息，自动进入快速模式
- 如果用户明确选择"1"或"快速模式"，进入快速模式

**步骤2：解析 userId**
- 从用户输入中提取 userId
- 从对话历史中获取 userId
- 如果都没有，询问用户

**步骤3：提取关键信息**
从用户自然语言输入中提取以下信息：
- 出差时间（travelStartDate, travelEndDate）
- 出差地点（城市名）
- 申请金额（originalCoin）
- 预算部门（costOrgName）
- 法人公司（enterpriseName）
- 成本中心（costCenterName）
- 费用项目（costName）
- 业务描述（remark）
- 出差范围（travelRange）

**步骤4：调用接口获取可选列表**
- 调用 searchApplyUserListNew 获取申请人列表
- 调用 searchCostOrganizationByUserId 获取预算部门列表
- 调用 searchEnterpriseByOrgId 获取法人公司列表
- 调用 searchCostCenterListByEnterpriseIdAndOrgId 获取成本中心列表
- 调用 searchCostItemByOrgAndResourcePage 获取费用项目列表
- 调用 searchCurrencyList 获取币种列表
- 调用 seachAreasList 获取地点列表（如果用户提到城市）

**步骤5：智能匹配和预测**
- 对提取的信息与接口返回的列表进行匹配
- 对于未提供的字段，使用智能预测：
  - 申请人：默认选择列表的第一个
  - 预算部门：默认选择列表的第一个
  - 法人公司：默认选择列表的第一个
  - 成本中心：默认选择列表的第一个
  - 费用项目：默认选择列表的第一个
  - 币种：默认选择人民币
  - 出差范围：默认选择国内

**步骤6：生成确认清单**
生成一个简洁的确认清单，展示所有预测和匹配的字段值：

```
请确认以下信息是否正确：

1. 申请人：张三 (id:1727596139882397698)
2. 预算部门：财务科 (id:1727507556643364900)
3. 法人公司：金宏集团 (id:1730125261242494978)
4. 成本中心：研发中心 (id:123456789)
5. 费用项目：差旅费 (id:987654321)
6. 币种：人民币 (id:1)
7. 出差地点：上海
8. 出差时间：2026-04-21 至 2026-04-23
9. 申请金额：3000 元
10. 业务描述：去上海洽谈业务
11. 出差范围：国内

以上信息是否正确？如果有需要修改的地方，请告诉我具体修改内容。
```

**步骤7：用户确认**
- 如果用户确认正确，直接调用保存接口
- 如果用户需要修改，重新解析修改内容并更新字段值
- 重复确认流程直到用户确认无误

## 引导模式实现

引导模式保持原有的逐层引导逻辑，按以下层级执行：
[第0层] 获取 userId → [第1层] 获取申请人 → [第2层] 获取预算部门 → [第3层] 获取法人公司 → [第4层] 获取成本中心 → [第5层] 获取费用项目 → [第6层] 获取币种/地点/同行人 → [第7层] 获取用户输入 → [提交]

## 列表展示格式（必须遵守）

当接口返回多条数据需要让用户选择时，**必须**按以下格式展示，把 `id` 包含在括号中：

```
请选择预算部门：
1. 财务科 (id:1727507556643364900)
2. 信息部 (id:1727507556643364866)
```

**注意**：
- 编号用 `1. 2. 3.` 格式
- 名称后面必须跟 `(id:具体id值)`
- 如果接口返回了 code，也一并展示：`1. 财务科 (id:xxx, code:JH3002)`
- **禁止只展示名称不展示 id**

## 字段映射速查表

> 以下表格展示了每个提交字段需要从哪个接口的哪个返回字段取值。**在调用接口和用户选择时，务必对照此表。**

| 提交字段 | 取值来源接口 | 取值来源字段 |
|---------|------------|------------|
| applyBy | searchApplyUserListNew | `data[].id` |
| applyCode | searchApplyUserListNew | `data[].userCode` |
| applyName | searchApplyUserListNew | `data[].nickName` |
| applyOrgId | searchApplyUserListNew | `data[].orgId` |
| applyOrgCode | searchApplyUserListNew | `data[].orgCode` |
| applyOrgName | searchApplyUserListNew | `data[].orgName` |
| costOrgId | searchCostOrganizationByUserId | `data[].id` |
| costOrgCode | searchCostOrganizationByUserId | `data[].orgCode` |
| costOrgName | searchCostOrganizationByUserId | `data[].orgName` |
| enterpriseId | searchEnterpriseByOrgId | `data[].id` |
| enterpriseCode | searchEnterpriseByOrgId | `data[].enterpriseCode` |
| enterpriseName | searchEnterpriseByOrgId | `data[].enterpriseName` |
| costCenterId | searchCostCenterListByEnterpriseIdAndOrgId | `data[].id` |
| costCenterCode | searchCostCenterListByEnterpriseIdAndOrgId | `data[].costCenterCode` |
| costCenterName | searchCostCenterListByEnterpriseIdAndOrgId | `data[].costCenterName` |
| costId | searchCostItemByOrgAndResourcePage | `data[].id` |
| costCode | searchCostItemByOrgAndResourcePage | `data[].costCode` |
| costName | searchCostItemByOrgAndResourcePage | `data[].costName` |
| currencyId | searchCurrencyList | `data[].id` |
| currencyCode | searchCurrencyList | `data[].currencyCode` |
| currencyName | searchCurrencyList | `data[].currencyName` |

## 执行流程

```
[第0层] 获取 userId → [第1层] 获取申请人 → [第2层] 获取预算部门 → [第3层] 获取法人公司 → [第4层] 获取成本中心 → [第5层] 获取费用项目 → [第6层] 获取币种/地点/同行人 → [第7层] 获取用户输入 → [提交]
```

---

### 第0层：获取 userId

**检查顺序**：
1. 检查「已获取参数」部分
2. 检查「询问历史」部分
3. 如果都没有，询问用户

---

### 第1层：获取申请人（依赖 userId）

**步骤1：检查已有信息**
- 检查「已获取参数」中是否有
- 检查「询问历史」中用户是否已回复过相关选择
- 如果都已获取 → 直接记录字段值，跳到第2层

**步骤2：调用接口获取列表**
使用 bash 工具执行以下命令：
```bash
# 查询申请人列表（返回 data[].id, userCode, nickName, orgId, orgCode, orgName）
node scripts/api-call.js '{"method":"POST","path":"/edo-base/user/searchApplyUserListNew","params":{"userId":"<userId>","orderTypeCode":"sqcl"}}'
```

**步骤3：用户选择**
- 如果只有一条数据 → 自动选择，**记录该条数据的 id/code/name**，无需询问
- 如果有多条数据 → 按「列表展示格式」展示列表让用户选择（必须包含 id）
- 用户选择后，**从询问历史中的列表文本解析出对应项的 id/code/name**

**步骤4：记录字段值**
用户选择申请人后，立即记录以下 6 个字段：
- `applyBy` = 所选项的 `id`
- `applyCode` = 所选项的 `userCode`
- `applyName` = 所选项的 `nickName`
- `applyOrgId` = 所选项的 `orgId`
- `applyOrgCode` = 所选项的 `orgCode`
- `applyOrgName` = 所选项的 `orgName`

---

### 第2层：获取预算部门（依赖 userId）

**步骤1：检查已有信息**
- 检查「已获取参数」中是否有
- 检查「询问历史」中用户是否已回复过相关选择
- 如果都已获取 → 直接记录字段值，跳到第3层

**步骤2：调用接口获取列表**
使用 bash 工具执行以下命令：
```bash
# 查询预算占用部门列表（返回 data[].id, orgCode, orgName）
node scripts/api-call.js '{"method":"POST","path":"/edo-base/userOrgCost/searchCostOrganizationByUserId","params":{"userId":"<userId>","isFinal":"1"}}'
```

**步骤3：用户选择**
- 如果只有一条数据 → 自动选择，**记录该条数据的 id/code/name**，无需询问
- 如果有多条数据 → 按「列表展示格式」展示列表让用户选择（必须包含 id）
- 用户选择后，**从询问历史中的列表文本解析出对应项的 id/code/name**

**步骤4：记录字段值**
用户选择预算部门后，立即记录以下 3 个字段：
- `costOrgId` = 所选项的 `id`  ⚠️ **注意：是 id，不是 orgCode**
- `costOrgCode` = 所选项的 `orgCode`
- `costOrgName` = 所选项的 `orgName`

---

### 第3层：获取法人公司（依赖 costOrgId）

> ⚠️ **本层接口需要 `costOrgId`（预算部门的 id），不是 orgCode，不是 orgName**

**步骤1：检查已有信息**
- 检查「已获取参数」中是否有
- 检查「询问历史」中用户是否已回复过相关选择
- 如果都已获取 → 直接记录字段值，跳到第4层

**步骤2：调用接口获取列表**
使用 bash 工具执行以下命令：
```bash
# 查询法人公司列表（返回 data[].id, enterpriseCode, enterpriseName）
node scripts/api-call.js '{"method":"POST","path":"/edo-base/enterpriseOrg/searchEnterpriseByOrgId","params":{"orgId":"<costOrgId>"}}'
```

**步骤3：用户选择**
- 如果只有一条数据 → 自动选择，**记录该条数据的 id/code/name**，无需询问
- 如果有多条数据 → 按「列表展示格式」展示列表让用户选择（必须包含 id）
- 用户选择后，**从询问历史中的列表文本解析出对应项的 id/code/name**

**步骤4：记录字段值**
用户选择法人公司后，立即记录以下 3 个字段：
- `enterpriseId` = 所选项的 `id`  ⚠️ **注意：是 id，不是 enterpriseCode**
- `enterpriseCode` = 所选项的 `enterpriseCode`
- `enterpriseName` = 所选项的 `enterpriseName`

---

### 第4层：获取成本中心（依赖 costOrgId 和 enterpriseId）

> ⚠️ **本层接口需要 `costOrgId`（预算部门的 id）和 `enterpriseId`（法人公司的 id）**

**步骤1：检查已有信息**
- 检查「已获取参数」中是否有
- 检查「询问历史」中用户是否已回复过相关选择
- 如果都已获取 → 直接记录字段值，跳到第5层

**步骤2：调用接口获取列表**
使用 bash 工具执行以下命令：
```bash
# 查询成本中心列表（返回 data[].id, costCenterCode, costCenterName）
node scripts/api-call.js '{"method":"POST","path":"/edo-base/costCenter/searchCostCenterListByEnterpriseIdAndOrgId","params":{"enterpriseId":"<enterpriseId>","orgId":"<costOrgId>"}}'
```

**步骤3：用户选择**
- 如果只有一条数据 → 自动选择，**记录该条数据的 id/code/name**，无需询问
- 如果有多条数据 → 按「列表展示格式」展示列表让用户选择（必须包含 id）
- 用户选择后，**从询问历史中的列表文本解析出对应项的 id/code/name**

**步骤4：记录字段值**
用户选择成本中心后，立即记录以下 3 个字段：
- `costCenterId` = 所选项的 `id`  ⚠️ **注意：是 id，不是 costCenterCode**
- `costCenterCode` = 所选项的 `costCenterCode`
- `costCenterName` = 所选项的 `costCenterName`

---

### 第5层：获取费用项目（依赖 costCenterId）

> ⚠️ **本层接口需要 `costCenterId`（成本中心的 id）**

**步骤1：检查已有信息**
- 检查「已获取参数」中是否有
- 检查「询问历史」中用户是否已回复过相关选择
- 如果都已获取 → 直接记录字段值，跳到第6层

**步骤2：调用接口获取列表**
使用 bash 工具执行以下命令：
```bash
# 查询费用项目列表（返回 data[].id, costCode, costName）
# ⚠️ 此接口参数必须放在 body 中
node scripts/api-call.js '{"method":"POST","path":"/edo-base/resourceCostDetail/searchCostItemByOrgAndResourcePage","body":{"resourceCode":"sqcl","orgId":"<costCenterId>"}}'
```

**步骤3：用户选择**
- 如果只有一条数据 → 自动选择，**记录该条数据的 id/code/name**，无需询问
- 如果有多条数据 → 按「列表展示格式」展示列表让用户选择（必须包含 id）
- 用户选择后，**从询问历史中的列表文本解析出对应项的 id/code/name**

**步骤4：记录字段值**
用户选择费用项目后，立即记录以下 3 个字段：
- `costId` = 所选项的 `id`  ⚠️ **注意：是 id，不是 costCode**
- `costCode` = 所选项的 `costCode`
- `costName` = 所选项的 `costName`

---

### 第6层：获取币种、地点、同行人（独立数据源）

**币种**：

使用 bash 工具执行以下命令：
```bash
# 查询币种列表（返回 data[].id, currencyCode, currencyName）
node scripts/api-call.js '{"method":"POST","path":"/edo-base/currency/searchCurrencyList","params":{}}'
```

选择后记录：
- `currencyId` = 所选项的 `id`
- `currencyCode` = 所选项的 `currencyCode`
- `currencyName` = 所选项的 `currencyName`

**出差地点**（用户输入城市名）：

使用 bash 工具执行以下命令：
```bash
# ⚠️ 此接口参数必须放在 body 中
node scripts/api-call.js '{"method":"POST","path":"/edo-base/areas/seachAreasList","body":{"levelType":2,"name":"<城市名>"}}'
```

选择后记录到 `areas` 数组：
- `areasCode` = 所选项的 `areasCode`
- `areasName` = 所选项的 `areasName`

**同行人员**（可选，用户输入姓名）：

使用 bash 工具执行以下命令：
```bash
# ⚠️ 此接口参数必须放在 body 中
node scripts/api-call.js '{"method":"POST","path":"/edo-base/user/searchUserList","body":{"nickName":"<姓名>"}}'
```

选择后记录到 `associates` 数组：
- `associateBy` = 所选项的 `id`
- `associateName` = 所选项的 `nickName`

---

### 第7层：获取用户输入

直接从用户输入中提取：
- **申请金额** (originalCoin)：数字提取，如 "3000块" → 3000
- **业务描述** (remark)：直接提取
- **出差时间** (travelStartDate, travelEndDate)：解析日期，如 "4月20日到22日" → 2026-04-20 ~ 2026-04-22
- **出差范围** (travelRange)："国内"→3, "国际"→4, "港澳台"→5

---

### 提交申请单

**提交前校验**：确认以下所有字段都已收集完毕，如有缺失则返回对应层级获取。

**调用保存接口**：
使用 bash 工具执行以下命令：
```bash
node scripts/submit-travel-apply.js '{
  "applyBy": <Long>,
  "applyCode": "<String>",
  "applyName": "<String>",
  "applyOrgId": <Long>,
  "applyOrgCode": "<String>",
  "applyOrgName": "<String>",
  "costOrgId": <Long>,
  "costOrgCode": "<String>",
  "costOrgName": "<String>",
  "enterpriseId": <Long>,
  "enterpriseCode": "<String>",
  "enterpriseName": "<String>",
  "costCenterId": <Long>,
  "costCenterCode": "<String>",
  "costCenterName": "<String>",
  "costId": <Long>,
  "costCode": "<String>",
  "costName": "<String>",
  "currencyId": <Long>,
  "currencyCode": "<String>",
  "currencyName": "<String>",
  "originalCoin": <Number>,
  "remark": "<String>",
  "travelStartDate": "yyyy-MM-dd",
  "travelEndDate": "yyyy-MM-dd",
  "travelRange": <Integer>,
  "areas": [{"code": "<areasCode>", "name": "<areasName>"}],
  "associates": [{"id": <associateBy>, "name": "<associateName>"}]
}'
```

## 执行规则

1. **按层级顺序执行**：必须先完成第N层，才能执行第N+1层
2. **优先使用已有信息**：每层开始前，先检查「已获取参数」和「询问历史」
3. **用户选择后立即记录完整字段**：不要只记 name，必须同时记录 id 和 code
4. **下游接口只用 id**：传给接口的参数永远是 `id` 字段（如 costOrgId、orgId），不是 code 也不是 name
5. **多条数据让用户选择时，必须按「列表展示格式」展示**：每个选项必须包含 id，方便恢复任务时从询问历史中解析
6. **只有一条数据时自动选择**：不要让用户做无意义的选择，直接使用唯一选项
7. **用户可一次性提供多个信息**：解析用户输入，提取所有可用信息，跳过已获取的字段层级
