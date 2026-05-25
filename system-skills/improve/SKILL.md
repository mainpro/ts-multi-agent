---
name: system-improve
description: 检查 improvement.md 中的待处理改进建议，逐条分析、生成修改方案、通过审批后执行修改
metadata:
  systemName: 系统自改进
  executor: improvement-agent
  adminOnly: true
allowedTools:
  - read
  - glob
  - grep
  - ask_user
---

# 系统自改进技能

## 工作流程

1. **读取待处理条目**: 读取 improvement.md 中的 Pending 区，按优先级排序
2. **逐条分析**: 对每条待处理条目，分析根因是否明确、修改建议是否合理
3. **生成修改方案**: 输出具体的文件修改 diff
4. **审批**: 向用户展示修改方案，等待确认（yes/no/skip）
5. **执行修改**: 审批通过后执行文件修改
6. **更新状态**: 更新 improvement.md 中条目的状态（completed/rejected）

## 执行频率

- 仅在用户输入 `/improve` 命令时触发
- 不自动执行
