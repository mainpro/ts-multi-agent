---
name: error-analyzer
description: 分析智能体执行错误的根本原因
type: professional
targetAgent: critic
metadata:
  category: error-management
  priority: high
allowedTools:
  - log-parser
  - pattern-analyzer
---

# 错误分析技能

## 错误分类

| 错误类型 | 描述 | 常见场景 |
|---------|------|---------|
| API_ERROR | API 调用失败 | 网络问题、权限问题 |
| TOOL_ERROR | 工具执行错误 | 参数错误、超时 |
| LOGIC_ERROR | 逻辑错误 | 推理错误、路径选择错误 |
| HALLUCINATION | 幻觉 | 编造事实 |
| TIMEOUT | 超时错误 | 执行时间过长 |
| MEMORY_ERROR | 内存错误 | 内存使用过高 |

## 分析流程

1. **错误信息提取**：从任务日志中提取错误详情
2. **错误模式识别**：匹配已知错误模式
3. **根因分析**：分析错误的根本原因
4. **影响评估**：评估错误对系统的影响
5. **解决方案生成**：生成具体的解决方案

## 输出格式

```json
{
  "errorType": "API_ERROR" | "TOOL_ERROR" | "LOGIC_ERROR" | "HALLUCINATION" | "TIMEOUT" | "MEMORY_ERROR",
  "rootCause": string,
  "errorPattern": string,
  "impact": {
    "severity": "low" | "medium" | "high" | "critical",
    "affectedComponents": string[],
    "userImpact": string
  },
  "recommendedActions": string[]
}
```

## 根因分析方法

### 1. 故障树分析
- 从错误现象出发，逐步分析可能的原因
- 构建故障树，识别根本原因

### 2. 模式匹配
- 匹配已知的错误模式
- 利用历史数据和经验

### 3. 相关性分析
- 分析错误与其他事件的相关性
- 识别触发条件

## 解决方案生成

根据错误类型和根因，生成具体的解决方案：

### API_ERROR
- 检查网络连接
- 验证API密钥和权限
- 实现重试机制
- 添加错误处理逻辑

### TOOL_ERROR
- 验证工具参数
- 检查工具依赖
- 增加输入验证
- 优化工具调用顺序

### LOGIC_ERROR
- 改进推理逻辑
- 添加逻辑验证步骤
- 增加边界情况处理
- 优化决策路径

### HALLUCINATION
- 增强事实验证
- 添加数据来源引用
- 优化提示词
- 增加人类监督

### TIMEOUT
- 优化执行路径
- 增加超时处理
- 实现异步执行
- 优化资源使用

### MEMORY_ERROR
- 优化内存使用
- 增加内存监控
- 实现数据分页
- 优化缓存策略

## 示例

### 输入：
任务执行日志：
```
[TaskQueue] 开始执行任务: task-123
[SubAgent] 调用工具: api-call
[SubAgent] 工具返回错误: 401 Unauthorized
[TaskQueue] 任务执行失败: task-123
```

### 输出：
```json
{
  "errorType": "API_ERROR",
  "rootCause": "API调用未授权，可能是token过期或权限不足",
  "errorPattern": "API 401 Unauthorized",
  "impact": {
    "severity": "high",
    "affectedComponents": ["api-call工具", "SubAgent执行"],
    "userImpact": "任务无法完成，需要重新获取授权"
  },
  "recommendedActions": [
    "检查API token是否过期",
    "验证用户权限是否足够",
    "实现token自动刷新机制",
    "添加错误处理和用户提示"
  ]
}
```