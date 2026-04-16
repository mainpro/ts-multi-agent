# 差旅费用申请单 - 接口规范

## 基础信息

- **测试地址**: `http://221.224.251.134:6770/api/`
- **请求方式**: POST (JSON) 或 GET
- **通用响应格式**: `{ code: 200, msg: "", data: ... }`

---

## 1. 保存差旅费用申请单（主接口）

**接口地址**: `POST /edo-reimburse/applyTravel/saveApplyTravel`

### 输入参数

| 参数名 | 类型 | 必填 | 描述 | 说明 |
|--------|------|------|------|------|
| orderType | String | 是 | 单据类型 | 固定传 `"sqcl"` |
| applyBy | Long | 是 | 申请人id | 来自查询申请人列表 |
| applyCode | String | 是 | 申请人编码 | 来自查询申请人列表 |
| applyName | String | 是 | 申请人名称 | 来自查询申请人列表 |
| applyOrgId | Long | 是 | 申请人所属部门id | 来自查询申请人列表 |
| applyOrgCode | String | 是 | 申请人所属部门编码 | 来自查询申请人列表 |
| applyOrgName | String | 是 | 申请人所属部门名称 | 来自查询申请人列表 |
| approvalStatus | String | 是 | 审批状态 | 固定传 `"sp"` |
| costOrgId | Long | 是 | 预算占用部门id | 来自查询预算占用部门列表 |
| costOrgCode | String | 是 | 预算占用部门编码 | 来自查询预算占用部门列表 |
| costOrgName | String | 是 | 预算占用部门名称 | 来自查询预算占用部门列表 |
| enterpriseId | Long | 是 | 法人公司id | 来自查询法人公司列表 |
| enterpriseCode | String | 是 | 法人公司编码 | 来自查询法人公司列表 |
| enterpriseName | String | 是 | 法人公司名称 | 来自查询法人公司列表 |
| costId | Long | 是 | 费用项目id | 来自查询费用项目列表 |
| costCode | String | 是 | 费用项目编码 | 来自查询费用项目列表 |
| costName | String | 是 | 费用项目名称 | 来自查询费用项目列表 |
| remark | String | 是 | 业务描述 | 用户输入 |
| currencyId | Long | 是 | 币种id | 来自查询币种列表 |
| currencyCode | String | 是 | 币种编码 | 来自查询币种列表 |
| currencyName | String | 是 | 币种名称 | 来自查询币种列表 |
| exchangeRate | Double | 是 | 汇率 | 默认传 `1` |
| originalCoin | Double | 是 | 原币金额/申请金额 | 用户输入 |
| localCurrency | Double | 是 | 本币金额 | 与 originalCoin 一致 |
| travelStartDate | String | 是 | 出差开始时间 | 格式 `yyyy-MM-dd` |
| travelEndDate | String | 是 | 出差结束时间 | 格式 `yyyy-MM-dd` |
| travelRange | Integer | 是 | 出差范围 | `3`=国内, `4`=国际, `5`=港澳台 |
| areasPOS | List | 是 | 出差地点列表 | 见下方结构 |
| associatePOS | List | 是 | 同行人列表 | 可为空数组 `[]`，见下方结构 |

#### areasPOS 结构

```json
[
  { "areasCode": "310000", "areasName": "上海市" }
]
```

#### associatePOS 结构

```json
[
  { "associateBy": 123456, "associateName": "张三" }
]
```

### 输出参数

| 参数名 | 类型 | 描述 |
|--------|------|------|
| code | int | 状态码（200成功，其他失败） |
| msg | String | 错误信息 |

---

## 2. 查询申请人列表

**接口地址**: `POST /edo-base/user/searchApplyUserListNew`

### 输入参数（Query Params）

| 参数名 | 类型 | 必填 | 描述 |
|--------|------|------|------|
| userId | Long | 是 | 当前登陆用户id |
| orderTypeCode | String | 是 | 单据类型编码。`sqcl`=差旅费用申请, `bxcl`=差旅费用报账, `bxclks`=无申请差旅费用报账 |

### 输出 data 结构

| 字段 | 类型 | 描述 |
|------|------|------|
| id | Long | 人员id |
| userCode | String | 人员编码（工号） |
| nickName | String | 人员姓名 |
| orgId | Long | 所属部门id |
| orgCode | String | 所属部门编码 |
| orgName | String | 所属部门名称 |

---

## 3. 查询预算占用部门列表

**接口地址**: `POST /edo-base/userOrgCost/searchCostOrganizationByUserId`

### 输入参数（Query Params）

| 参数名 | 类型 | 必填 | 描述 |
|--------|------|------|------|
| userId | Long | 是 | 申请人id |
| isFinal | String | 是 | 是否末级部门，默认传 `"1"` |

### 输出 data 结构

| 字段 | 类型 | 描述 |
|------|------|------|
| id | Long | 部门id |
| orgCode | String | 部门编码 |
| orgName | String | 部门名称 |

---

## 4. 查询法人公司列表

**接口地址**: `POST /edo-base/enterpriseOrg/searchEnterpriseByOrgId`

### 输入参数（Query Params）

| 参数名 | 类型 | 必填 | 描述 |
|--------|------|------|------|
| orgId | Long | 是 | 预算占用部门id |

### 输出 data 结构

| 字段 | 类型 | 描述 |
|------|------|------|
| id | Long | 法人公司id |
| enterpriseCode | String | 法人公司编码 |
| enterpriseName | String | 法人公司名称 |

---

## 5. 查询币种列表

**接口地址**: `POST /edo-base/currency/searchCurrencyList`

### 输入参数

无

### 输出 data 结构

| 字段 | 类型 | 描述 |
|------|------|------|
| id | Long | 币种id |
| currencyCode | String | 币种编码 |
| currencyName | String | 币种名称 |

---

## 6. 查询费用项目列表

**接口地址**: `POST /edo-base/resourceCostDetail/searchCostItemByOrgAndResourcePage`

### 输入参数（Query Params）

| 参数名 | 类型 | 必填 | 描述 |
|--------|------|------|------|
| resourceCode | String | 是 | 单据类型编码，固定传 `sqcl` |
| orgId | Long | 是 | 预算占用部门id |

### 输出 data 结构

| 字段 | 类型 | 描述 |
|------|------|------|
| id | Long | 费用项目id |
| costCode | String | 费用项目编码 |
| costName | String | 费用项目名称 |

---

## 7. 查询地点信息列表

**接口地址**: `POST /edo-base/areas/seachAreasList`

### 输入参数

| 参数名 | 类型 | 必填 | 描述 |
|--------|------|------|------|
| levelType | Integer | 否 | 地点级别，默认 `2`（市级） |
| name | String | 否 | 地点名称（模糊搜索） |

### 输出 data 结构

| 字段 | 类型 | 描述 |
|------|------|------|
| areasCode | String | 地点编码 |
| areasName | String | 地点名称 |

---

## 8. 查询同行人员信息列表

**接口地址**: `POST /edo-base/user/searchUserList`

### 输入参数

| 参数名 | 类型 | 必填 | 描述 |
|--------|------|------|------|
| nickName | String | 否 | 人员姓名（模糊搜索） |

### 输出 data 结构

| 字段 | 类型 | 描述 |
|------|------|------|
| id | Long | 人员id |
| userCode | String | 人员编码 |
| nickName | String | 人员姓名 |

---

## 数据来源关系

保存申请单时，各字段的数据来源：

| 字段 | 来源接口 | 对应字段 |
|------|----------|----------|
| applyBy | 查询申请人列表 | id |
| applyCode | 查询申请人列表 | userCode |
| applyName | 查询申请人列表 | nickName |
| applyOrgId | 查询申请人列表 | orgId |
| applyOrgCode | 查询申请人列表 | orgCode |
| applyOrgName | 查询申请人列表 | orgName |
| costOrgId | 查询预算占用部门列表 | id |
| costOrgCode | 查询预算占用部门列表 | orgCode |
| costOrgName | 查询预算占用部门列表 | orgName |
| enterpriseId | 查询法人公司列表 | id |
| enterpriseCode | 查询法人公司列表 | enterpriseCode |
| enterpriseName | 查询法人公司列表 | enterpriseName |
| costId | 查询费用项目列表 | id |
| costCode | 查询费用项目列表 | costCode |
| costName | 查询费用项目列表 | costName |
| currencyId | 查询币种列表 | id |
| currencyCode | 查询币种列表 | currencyCode |
| currencyName | 查询币种列表 | currencyName |
