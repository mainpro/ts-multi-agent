

## Task 8: SubAgent 执行引擎 - 完成记录

**完成时间**: 2026-02-11
**文件位置**: `src/agents/sub-agent.ts`

### 实现的功能

1. **SubAgent 类**
   - 接收 `SkillRegistry` 和 `LLMClient` 作为依赖
   - 实现了单层执行限制（不处理嵌套 SubAgent）

2. **execute() 方法**
   - 接收 Task 对象，验证 skillName 存在
   - 使用 `SkillRegistry.loadFullSkill()` 加载完整 Skill
   - 调用 `runSkill()` 执行 Skill
   - 使用 `classifyError()` 分类并返回错误

3. **runSkill() 方法**
   - 优先尝试脚本执行（如果 skill.scriptsDir 存在）
   - 脚本失败时自动回退到 LLM 执行
   - 脚本选择优先级：operation-specific.js → index.js → main.js → run.js

4. **runScript() 方法**
   - 使用 `child_process.execFile` 执行 Node.js 脚本
   - 通过环境变量 `SKILL_PARAMS` 传递参数
   - 处理超时（使用 CONFIG.TASK_TIMEOUT_MS）
   - 尝试将输出解析为 JSON，失败则返回字符串

5. **runLLMExecution() 方法**
   - 使用 Skill 的 body 和 description 构建 system prompt
   - 将 params 作为 user prompt 传递给 LLM
   - 尝试解析返回值为 JSON

6. **classifyError() 方法**
   - **TIMEOUT** → RETRYABLE（可重试）
   - **SKILL_NOT_FOUND** → FATAL（需要重新规划）
   - **MISSING_SKILL** → FATAL
   - **INVALID_KEY** → FATAL
   - **RATE_LIMIT / NETWORK_ERROR** → RETRYABLE
   - **SCRIPT_NOT_FOUND** → SKILL_ERROR
   - **PERMISSION_DENIED** → FATAL
   - 其他错误 → SKILL_ERROR

### 设计决策

1. **脚本执行优先**: 如果 Skill 有 scripts/ 目录，优先执行脚本，失败时才回退到 LLM
2. **参数传递**: 通过环境变量 `SKILL_PARAMS` 传递 JSON 序列化的参数
3. **超时处理**: 脚本执行使用 CONFIG.TASK_TIMEOUT_MS (30s) 作为超时
4. **错误分类**: 遵循计划中的分类规则，TIMEOUT 为 RETRYABLE，SKILL_NOT_FOUND 为 FATAL

### 依赖的模块

- `../skill-registry` - SkillRegistry 类
- `../llm` - LLMClient 类
- `../types` - Task, TaskResult, TaskError, ErrorType, Skill, CONFIG
- `fs/promises` - 文件系统操作
- `path` - 路径处理
- `child_process` - 脚本执行

### 构建验证

```bash
$ bun run build
$ tsc
# 无错误，编译成功
```
