# 询问机制 v3 重构 — 测试执行报告

> 执行时间: 2026-04-21
> 执行环境: Node.js 22 + tsx

---

## 一、测试总览

| 模块 | 用例数 | 通过 | 失败 | 通过率 |
|------|--------|------|------|--------|
| SessionStore | 22 | 22 | 0 | 100% |
| RequestManager | 10 | 10 | 0 | 100% |
| SessionContextPrompt | 15 | 15 | 0 | 100% |
| MainAgent | 11 | 11 | 0 | 100% |
| API 层 | 8 | 8 | 0 | 100% |
| SubAgent (detectQuestion + classifyError) | 13 | 13 | 0 | 100% |
| **合计** | **79** | **79** | **0** | **100%** |

> 注：原测试计划 88 个用例中，MainAgent 18 个缩减为 11 个（MA-02/MA-09/MA-10/MA-11/MA-16/MA-17/MA-18 因需要完整 TaskQueue 执行流程，改为集成测试更合适），RequestManager 12 个缩减为 10 个（RM-07/RM-08 多挂起请求匹配用例与 RM-03/RM-04 逻辑重复），实际可单元测试用例 79 个。

---

## 二、发现并修复的 Bug

### Bug 1: `answerQuestion` 修改共享对象导致 `currentQuestion` 丢失
- **文件**: `src/agents/request-manager.ts`
- **严重程度**: 🔴 高（影响所有延续判断场景）
- **现象**: `handleUserInput` 返回 `{type: 'continue', question: null}`，导致 MainAgent 无法获取问题信息
- **根因**: `waitingRequest` 和 `answerQuestion` 操作的是同一个缓存对象。`answerQuestion` 将 `request.currentQuestion` 置为 `null` 后，`waitingRequest.currentQuestion` 引用也被置空
- **修复**: 在调用 `answerQuestion` 之前，先用局部变量保存 `question` 引用
```typescript
// 修复前
const updated = await this.sessionStore.answerQuestion(..., waitingRequest.currentQuestion.questionId, userInput);
if (updated) {
  return { type: 'continue', request: updated, question: waitingRequest.currentQuestion }; // null!
}

// 修复后
const question = waitingRequest.currentQuestion; // 先保存引用
const updated = await this.sessionStore.answerQuestion(..., question.questionId, userInput);
if (updated) {
  return { type: 'continue', request: updated, question }; // 正确
}
```

### Bug 2: `getSuspendedRequests` 排序不稳定
- **文件**: `src/memory/session-store.ts`
- **严重程度**: 🟡 中（影响挂起请求召回顺序）
- **现象**: 同一毫秒内挂起的多个请求排序不稳定
- **根因**: 使用 `updatedAt` 排序，但挂起操作在同一毫秒内完成时 `updatedAt` 相同
- **修复**: 改为使用 `createdAt` 排序（创建时间一定不同）
```typescript
// 修复前
.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
// 修复后
.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
```

---

## 三、各模块测试详情

### 3.1 SessionStore（22/22 ✅）

| # | 用例 | 状态 |
|---|------|------|
| SS-01 | 加载不存在的会话 → 创建新会话 | ✅ |
| SS-02 | 加载已有会话（缓存命中） | ✅ |
| SS-03 | 加载已有会话（缓存未命中） | ✅ |
| SS-04 | saveSession 防抖写入 | ✅ |
| SS-05 | flushToDisk 过滤内部字段 | ✅ |
| SS-06 | flushToDisk 自动创建目录 | ✅ |
| SS-07 | 创建请求 | ✅ |
| SS-08 | 创建多个请求 → 最新在前 | ✅ |
| SS-09 | 获取活跃请求 | ✅ |
| SS-10 | 获取活跃请求（无活跃） | ✅ |
| SS-11 | 更新请求 | ✅ |
| SS-12 | 更新不存在的请求 | ✅ |
| SS-13 | 添加询问 → 请求进入等待 | ✅ |
| SS-14 | 回答问题（有 taskId）→ 任务恢复 | ✅ |
| SS-15 | 回答问题（无 taskId）→ 仅请求恢复 | ✅ |
| SS-16 | 回答不存在的问题 | ✅ |
| SS-17 | 挂起请求 → 任务级联挂起 | ✅ |
| SS-18 | 挂起活跃请求 → 清除 activeRequestId | ✅ |
| SS-19 | 召回请求 → 任务级联恢复 | ✅ |
| SS-20 | 召回请求 → 设置 activeRequestId | ✅ |
| SS-21 | 获取挂起请求 → 按时间倒序 | ✅ |
| SS-22 | syncRequestStatus 聚合 | ✅ |

### 3.2 RequestManager（10/10 ✅）

| # | 用例 | 状态 |
|---|------|------|
| RM-01 | 有等待请求 + 延续判断 YES | ✅ |
| RM-02 | 有等待请求 + 延续判断 NO | ✅ |
| RM-03 | 无等待 + 有挂起 + 满足召回 | ✅ |
| RM-04 | 无等待 + 有挂起 + 不满足召回 | ✅ |
| RM-05 | 无等待 + 无挂起 → 新请求 | ✅ |
| RM-06 | 同时有等待和挂起 → 等待优先 | ✅ |
| RM-09 | 挂起请求 confidence < 0.6 → 不召回 | ✅ |
| RM-10 | LLM 返回无效 JSON → 默认延续 | ✅ |
| RM-11 | LLM 调用抛异常 → 默认延续 | ✅ |
| RM-12 | shouldRecall 失败 → 默认不召回 | ✅ |

### 3.3 SessionContextPrompt（15/15 ✅）

| # | 用例 | 状态 |
|---|------|------|
| SP-01 | 空会话 → 仅 header | ✅ |
| SP-02 | 活跃请求（无问题/任务） | ✅ |
| SP-03 | 主智能体问题标签 | ✅ |
| SP-04 | 子智能体问题标签 | ✅ |
| SP-05 | 未回答问题 → "(等待回答)" | ✅ |
| SP-06 | 活跃请求含任务 | ✅ |
| SP-07 | 任务级问题 | ✅ |
| SP-08 | 挂起请求 | ✅ |
| SP-09 | 无活跃但有挂起 | ✅ |
| SP-10 | 完整会话（所有 section） | ✅ |
| SP-11 | 任务无问题 | ✅ |
| SP-12 | 任务有已回答问题 | ✅ |
| SP-13 | 任务有未回答问题 | ✅ |
| SP-14 | 无效 taskId | ✅ |
| SP-15 | 多问题编号列表 | ✅ |

### 3.4 MainAgent（11/11 ✅）

| # | 用例 | 状态 |
|---|------|------|
| MA-01 | recall_prompt 分发 | ✅ |
| MA-03 | NO_SKILL_MATCHED | ✅ |
| MA-04 | unknown type → TypeScript 类型保证 | ✅ |
| MA-05 | imageAttachment 不中断流程 | ✅ |
| MA-06 | 异常处理 → 不抛出未捕获异常 | ✅ |
| MA-07 | recall 不存在 → REQUEST_NOT_FOUND | ✅ |
| MA-08 | recall 存在 → 正常继续 | ✅ |
| MA-12 | small_talk 意图 | ✅ |
| MA-13 | confirm_system（带问题） | ✅ |
| MA-14 | confirm_system（null question → 默认问题） | ✅ |
| MA-15 | unclear 意图 | ✅ |

### 3.5 API 层（8/8 ✅）

| # | 用例 | 状态 |
|---|------|------|
| API-01 | recallRequestId → 调用 recallRequest | ✅ |
| API-02 | 无 recallRequestId → 调用 processRequirement | ✅ |
| API-03 | sessionId 传递 | ✅ |
| API-04 | 无 sessionId → 使用 userId | ✅ |
| API-05 | 缺少 requirement → 400 | ✅ |
| API-06 | 成功 → SSE complete 事件 | ✅ |
| API-07 | 失败 → SSE error 事件 | ✅ |
| API-08 | recall_prompt → SSE 含 suspendedRequest | ✅ |

### 3.6 SubAgent detectQuestion + classifyError（13/13 ✅）

| # | 用例 | 状态 |
|---|------|------|
| DQ-01 | 空字符串 → null | ✅ |
| DQ-02 | 结论性语句 "操作已完成" → null | ✅ |
| DQ-03 | 结论性语句 "已成功处理" → null | ✅ |
| DQ-04 | 真正的提问 "请选择您要的系统" | ✅ |
| DQ-05 | 真正的提问 "请问您的岗位是财务岗吗？" | ✅ |
| DQ-06 | 查询结果展示（非提问） | ✅ |
| DQ-07 | 查询结果 + 问号（是提问） | ✅ |
| DQ-08 | 无 toolCallResults 的提问 | ✅ |
| SA-07 | 超时错误 → RETRYABLE/TIMEOUT | ✅ |
| SA-08 | 文件不存在 → FATAL/FILE_NOT_FOUND | ✅ |
| SA-09 | 权限错误 → FATAL/PERMISSION_DENIED | ✅ |
| SA-10 | 其他错误 → RETRYABLE/EXECUTION_ERROR | ✅ |
| SA-11 | 非 Error 类型 → RETRYABLE/UNKNOWN_ERROR | ✅ |

---

## 四、未覆盖用例（需集成测试）

以下用例因涉及完整的 TaskQueue 执行流程（LLM 调用 + Skill 加载 + 工具执行），不适合单元测试，建议在集成测试环境中覆盖：

| # | 用例 | 原因 |
|---|------|------|
| MA-02 | continue → 调用 continueRequest | 需要完整 TaskQueue 执行 |
| MA-09 | 子智能体任务继续（有 taskId） | 需要 SubAgent 完整执行 |
| MA-10 | 子智能体任务不存在 | 需要 SubAgent 完整执行 |
| MA-11 | 主智能体询问继续（无 taskId） | 需要 IntentRouter + processNormalRequirement |
| MA-16 | 子任务又产生询问 | 需要 SubAgent 返回 waiting_user_input |
| MA-17 | 需要意图重分类 | 需要 SubAgent 返回 needs_intent_reclassification |
| MA-18 | 正常完成 | 需要完整执行流程 |
| RM-07 | 多个挂起 → 第一个匹配 | 与 RM-03 逻辑重复 |
| RM-08 | 多个挂起 → 第二个匹配 | 与 RM-04 逻辑重复 |
| E2E-01 ~ E2E-14 | 全部端到端用例 | 需要完整系统环境 |

---

## 五、编译验证

| 检查项 | 结果 |
|--------|------|
| v3 修改文件编译 | ✅ 零错误 |
| 预存文件编译 | ⚠️ 有 16 个预存错误（log-manager.ts, intent-router.ts, edit-tool.ts, write-tool.ts），与本次重构无关 |

---

## 六、测试文件清单

| 文件 | 用例数 |
|------|--------|
| `__tests__/session-store.test.ts` | 22 |
| `__tests__/request-manager.test.ts` | 10 |
| `__tests__/session-context-prompt.test.ts` | 15 |
| `__tests__/main-agent.test.ts` | 11 |
| `__tests__/api.test.ts` | 8 |
| `__tests__/sub-agent-unit.test.ts` | 13 |

---

## 七、结论

✅ **79/79 单元测试全部通过，发现并修复 2 个生产 Bug。**

本次 v3 询问机制重构的核心模块（SessionStore、RequestManager、SessionContextPrompt、MainAgent、API 层、SubAgent 检测逻辑）均已通过单元测试验证，代码质量可靠。剩余 9 个用例建议在集成测试环境中覆盖。
