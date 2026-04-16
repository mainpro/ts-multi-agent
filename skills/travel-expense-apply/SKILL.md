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
---

# 差旅费用申请单

帮助用户创建差旅费用申请单，通过渐进式收集必填字段，最终调用保存接口完成申请。

## ⚠️ 关键规则（必须遵守）

1. **接口返回的是列表，每个元素包含 `id`、`code`、`name` 等字段。下游接口需要的是 `id` 字段，绝对不能使用 `code` 或 `name`**
2. **用户选择后，必须从接口返回数据中提取完整的 id/code/name 三元组，不能只记 name 忘记 id**
3. **提交时所有字段都必须有值，不能省略任何字段**
4. **⚠️ 展示选择列表时，必须把每个选项的 id 一并展示**（见下方「列表展示格式」），因为任务可能会暂停等待用户回复，恢复后需要从询问历史中获取 id，如果列表中没有 id，将无法继续执行

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
| costId | searchCostItemByOrgAndResourcePage | `data[].id` |
| costCode | searchCostItemByOrgAndResourcePage | `data[].costCode` |
| costName | searchCostItemByOrgAndResourcePage | `data[].costName` |
| currencyId | searchCurrencyList | `data[].id` |
| currencyCode | searchCurrencyList | `data[].currencyCode` |
| currencyName | searchCurrencyList | `data[].currencyName` |

## 执行流程

```
[第0层] 获取 userId → [第1层] 获取申请人/预算部门 → [第2层] 获取法人公司/费用项目 → [第3层] 获取币种/地点/同行人 → [第4层] 获取用户输入 → [提交]
```

---

### 第0层：获取 userId

**检查顺序**：
1. 检查「已获取参数」部分
2. 检查「询问历史」部分
3. 如果都没有，询问用户

---

### 第1层：获取申请人和预算部门（依赖 userId）

**步骤1：检查已有信息**
- 检查「已获取参数」中是否有
- 检查「询问历史」中用户是否已回复过相关选择
- 如果都已获取 → 直接记录字段值，跳到第2层

**步骤2：调用接口获取列表**
使用 bash 工具执行以下命令：
```bash
# 查询申请人列表（返回 data[].id, userCode, nickName, orgId, orgCode, orgName）
node scripts/api-call.js '{"method":"POST","path":"/edo-base/user/searchApplyUserListNew","params":{"userId":"<userId>","orderTypeCode":"sqcl"}}'

# 查询预算占用部门列表（返回 data[].id, orgCode, orgName）
node scripts/api-call.js '{"method":"POST","path":"/edo-base/userOrgCost/searchCostOrganizationByUserId","params":{"userId":"<userId>","isFinal":"1"}}'
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

用户选择预算部门后，立即记录以下 3 个字段：
- `costOrgId` = 所选项的 `id`  ⚠️ **注意：是 id，不是 orgCode**
- `costOrgCode` = 所选项的 `orgCode`
- `costOrgName` = 所选项的 `orgName`

---

### 第2层：获取法人公司和费用项目（依赖 costOrgId）

> ⚠️ **本层接口需要 `costOrgId`（预算部门的 id），不是 orgCode，不是 orgName**

**步骤1：检查已有信息**
- 检查「已获取参数」中是否有
- 检查「询问历史」中用户是否已回复过相关选择
- 如果都已获取 → 直接记录字段值，跳到第3层

**步骤2：调用接口获取列表**
使用 bash 工具执行以下命令：
```bash
# 查询法人公司列表（返回 data[].id, enterpriseCode, enterpriseName）
node scripts/api-call.js '{"method":"POST","path":"/edo-base/enterpriseOrg/searchEnterpriseByOrgId","params":{"orgId":"<costOrgId>"}}'

# 查询费用项目列表（返回 data[].id, costCode, costName）
# ⚠️ 此接口参数必须放在 body 中
node scripts/api-call.js '{"method":"POST","path":"/edo-base/resourceCostDetail/searchCostItemByOrgAndResourcePage","body":{"resourceCode":"sqcl","orgId":"<costOrgId>"}}'
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

用户选择费用项目后，立即记录以下 3 个字段：
- `costId` = 所选项的 `id`  ⚠️ **注意：是 id，不是 costCode**
- `costCode` = 所选项的 `costCode`
- `costName` = 所选项的 `costName`

---

### 第3层：获取币种、地点、同行人（独立数据源）

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

### 第4层：获取用户输入

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
