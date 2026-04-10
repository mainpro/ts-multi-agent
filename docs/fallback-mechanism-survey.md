# 保底机制 (Fallback Mechanisms) 调研报告

## 1. 当前 Prompt 中的业务限制

### 1.1 转人工规则 (子智能体)
位置: `src/prompts/sub-agent.ts`

```typescript
// 当前硬编码在 prompt 中
- 用户明确转人工 → 直接转人工
- 文档无法回答 → 转人工
- 追问超过2次仍无法确定 → 转人工
```

### 1.2 意图分类规则 (主智能体)
位置: `src/prompts/main-agent.ts`

```typescript
// 4种意图类型
- skill_task: 具体系统功能、流程、操作
- small_talk: 闲聊/对话结束语
- confirm_system: 需要确认具体系统
- unclear: 无法匹配任何技能

// 匹配优先级
- 系统名精确匹配 → 直接匹配
- 关键词模糊匹配 → 反问确认
- 无法匹配 → unclear

// 特殊情况
- 用户否定猜测后 → 直接返回 unclear
- 多任务拆分规则
```

### 1.3 用户画像更新规则
位置: `src/agents/main-agent.ts`

```typescript
// 只有技能执行完成才更新画像
// 反问阶段不更新
```

---

## 2. 可抽取的保底机制

### 方案 A: 独立配置文件

```
config/
├── fallback-rules.json      # 保底规则配置
├── intent-types.json        # 意图类型定义
└── skill-matching.json      # 技能匹配规则
```

**fallback-rules.json 示例:**
```json
{
  "transferToHuman": {
    "triggers": [
      { "type": "explicit", "keywords": ["转人工", "转系统工程师"] },
      { "type": "no_answer", "maxRetries": 2 },
      { "type": "unclear", "maxQuestions": 2 }
    ],
    "message": "您好，我帮您转到人工这边，让工程师进一步帮您排查一下。"
  },
  "intentTypes": {
    "skill_task": { "description": "具体系统功能、流程、操作" },
    "small_talk": { "description": "闲聊/对话结束语" },
    "confirm_system": { "description": "需要确认具体系统" },
    "unclear": { "description": "无法匹配任何技能" }
  }
}
```

### 方案 B: 代码层配置

```typescript
// src/config/fallback.ts
export const FallbackConfig = {
  transferToHuman: {
    triggers: [
      { type: 'explicit', keywords: ['转人工', '转系统工程师'] },
      { type: 'no_answer', maxRetries: 2 },
      { type: 'unclear', maxQuestions: 2 }
    ],
    message: '您好，我帮您转到人工这边...'
  },
  
  intentTypes: {
    skill_task: { description: '具体系统功能、流程、操作' },
    // ...
  },
  
  matching: {
    exactMatchPriority: true,
    keywordFuzzyMatch: true,
    maxClarificationQuestions: 2
  }
};
```

---

## 3. 建议的抽取结构

| 机制 | 当前位置 | 建议抽取方式 | 切换难度 |
|------|----------|--------------|----------|
| 转人工触发条件 | prompt (硬编码) | JSON配置 | 低 |
| 转人工话术 | prompt (硬编码) | JSON配置 | 低 |
| 意图类型定义 | prompt (硬编码) | JSON配置 | 中 |
| 匹配优先级规则 | prompt (硬编码) | JSON配置 | 高 |
| 多任务拆分规则 | prompt (硬编码) | JSON配置 | 高 |

---

## 4. 下一步

1. 确认哪些规则需要抽取为可配置
2. 选择方案 A (JSON) 或 方案 B (代码配置)
3. 制定具体的实施计划

需要我继续分析某个具体规则吗？