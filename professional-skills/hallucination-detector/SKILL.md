---
name: hallucination-detector
description: 检测智能体输出中的幻觉内容
type: professional
targetAgent: critic
metadata:
  category: quality-assurance
  priority: high
allowedTools:
  - fact-check
  - consistency-verifier
---

# 幻觉检测技能

## 核心职责

1. **事实一致性检查**：验证智能体输出与工具调用结果的一致性
2. **逻辑连贯性分析**：检测输出中的逻辑矛盾
3. **事实准确性验证**：通过外部知识库验证事实

## 检测维度

| 维度 | 描述 | 检测方法 |
|------|------|----------|
| 事实幻觉 | 编造不存在的事实 | 与工具调用结果对比 |
| 逻辑幻觉 | 前后矛盾的陈述 | 逻辑一致性分析 |
| 数据幻觉 | 编造具体数据 | 数据源验证 |

## 输出格式

```json
{
  "hasHallucination": boolean,
  "confidence": 0.0-1.0,
  "issues": [
    {
      "type": "factual" | "logical" | "data",
      "severity": "low" | "medium" | "high",
      "description": string,
      "evidence": string,
      "location": string
    }
  ],
  "suggestions": string[]
}
```

## 检测流程

1. **输入分析**：分析智能体的输出内容
2. **工具调用结果对比**：与工具调用的实际结果进行对比
3. **逻辑分析**：检查输出中的逻辑一致性
4. **事实验证**：验证关键事实的准确性
5. **结果生成**：生成检测结果和改进建议

## 改进建议生成

根据检测结果，生成具体的改进建议：

- **对于事实幻觉**：建议添加数据验证步骤，确保输出基于实际数据
- **对于逻辑幻觉**：建议改进推理逻辑，确保前后一致
- **对于数据幻觉**：建议添加数据来源引用，增强可信度

## 示例

### 输入：
智能体输出："根据系统数据，2024年Q1的销售额为1000万元，同比增长25%。"
工具调用结果：{ "sales": 8000000, "growth": 15 }

### 输出：
```json
{
  "hasHallucination": true,
  "confidence": 0.95,
  "issues": [
    {
      "type": "factual",
      "severity": "high",
      "description": "销售额数据与工具调用结果不符",
      "evidence": "工具返回销售额为800万元，智能体输出为1000万元",
      "location": "销售额数据部分"
    },
    {
      "type": "data",
      "severity": "medium",
      "description": "增长率数据与工具调用结果不符",
      "evidence": "工具返回增长率为15%，智能体输出为25%",
      "location": "增长率数据部分"
    }
  ],
  "suggestions": [
    "直接使用工具返回的数据，避免自行修改",
    "添加数据来源说明，增强可信度",
    "在输出前进行数据验证，确保准确性"
  ]
}
```