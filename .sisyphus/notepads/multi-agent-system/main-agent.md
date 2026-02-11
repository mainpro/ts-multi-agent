
## Task 7: MainAgent 规划器 - 完成总结

**日期**: 2026-02-11

### 交付物
- ✅ `src/agents/main-agent.ts` - MainAgent 类完整实现
- ✅ 所有核心方法实现完成
- ✅ `bun run build` 通过无错误

### 实现的核心方法

1. **processRequirement()** - 主入口
   - 协调完整的处理流程：分析 → 发现技能 → 创建计划 → 监控执行
   - 处理无可用技能的边界情况

2. **analyzeRequirement()** - 需求分析
   - 使用 LLM.generateStructured() 获取结构化分析
   - 提取 summary, entities, intent, suggestedSkills

3. **discoverSkills()** - 技能发现
   - 从 SkillRegistry 获取所有技能元数据
   - 使用 LLM 匹配需求与可用技能
   - 过滤返回实际存在的技能

4. **createPlan()** - 任务规划
   - 生成 DAG（有向无环图）任务依赖结构
   - 使用 TaskPlanSchema 验证 LLM 输出
   - 自动设置 planId 和 requirement

5. **monitorAndReplan()** - 监控与重规划
   - 轮询等待任务完成
   - 错误分类逻辑：只有全部 RETRYABLE 才重规划
   - 最多 MAX_REPLAN_ATTEMPTS=3 次重试
   - 超时处理（使用 CONFIG.TOTAL_TIMEOUT_MS）

### 关键设计决策

1. **错误处理策略**
   - RETRYABLE 错误（超时、网络错误）：触发重规划
   - FATAL/SKILL_ERROR/USER_ERROR：立即失败
   - 通过 `errors.every(e => e.type === 'RETRYABLE')` 判断

2. **任务队列集成**
   - `submitPlanTasks()` 将计划任务提交到 TaskQueue
   - 自动计算 dependents（反向依赖）
   - `waitForCompletion()` 轮询检查完成状态

3. **重规划机制**
   - 失败时调用 LLM 生成新计划
   - 提供错误摘要给 LLM 作为上下文
   - 取消旧任务，提交新任务

### 集成点

- **LLMClient**: 用于需求分析、技能发现、计划生成
- **SkillRegistry**: 获取可用技能元数据
- **TaskQueue**: 提交任务、监控状态、取消任务
- **CONFIG**: 使用 MAX_REPLAN_ATTEMPTS, TOTAL_TIMEOUT_MS 等常量

### 代码风格

- 移除了冗余注释，保持代码自解释
- 使用私有方法封装内部逻辑
- 遵循现有模块的 TypeScript 风格

