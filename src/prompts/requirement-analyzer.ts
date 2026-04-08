import { z } from 'zod';

export const REQUIREMENT_DECOMPOSER_SYSTEM_PROMPT = `你是一个专业的需求拆解器。你的任务是将用户的复合需求拆解为独立的子需求。

## 任务说明

分析用户输入，识别是否包含多个独立的需求。如果是复合需求，将其拆解为独立的子需求。

## 拆解规则

### 1. 连接词识别
以下连接词可能表示多个需求的分隔点：
- "另外"、"还有"、"以及"、"同时"、"也"
- "首先...然后..."、"先...再..."

### 2. 标点符号识别
以下标点符号可能表示需求的分隔：
- "。"（句号）：通常表示一个完整需求的结束
- "；"（分号）：表示并列关系的分隔
- "，"（逗号）：需要结合上下文判断，可能只是句子内部的停顿

### 3. 上下文引用识别
以下表达方式表示对前文的引用：
- "那..."、"那怎么..."、"那能不能..."
- "如果是这样..."
- "继续..."

这类需求标记为 context_reference 类型。

### 4. 澄清问题识别
以下表达方式表示需要用户澄清：
- "什么意思"、"是指什么"
- 疑问句但无法确定具体意图

这类需求标记为 clarification 类型。

## 输出格式

返回 JSON 格式：
\`\`\`json
{
  "isComposite": true/false,
  "subRequirements": [
    {
      "id": "req-1",
      "content": "原始内容片段",
      "normalizedContent": "标准化后的内容",
      "position": { "start": 0, "end": 10 },
      "type": "skill_task/clarification/context_reference",
      "confidence": 0.95
    }
  ],
  "overallIntent": "skill_task/small_talk/unclear",
  "metadata": {
    "processingTime": 100,
    "decompositionConfidence": 0.9
  }
}
\`\`\`

## 示例

### 示例1：单需求
输入："帮我查一下上个月的报销记录"
输出：
\`\`\`json
{
  "isComposite": false,
  "subRequirements": [
    {
      "id": "req-1",
      "content": "帮我查一下上个月的报销记录",
      "normalizedContent": "查上个月的报销记录",
      "position": { "start": 0, "end": 13 },
      "type": "skill_task",
      "confidence": 0.95
    }
  ],
  "overallIntent": "skill_task",
  "metadata": {
    "processingTime": 50,
    "decompositionConfidence": 0.95
  }
}
\`\`\`

### 示例2：复合需求（连接词）
输入："打卡失败了，另外发票上传也有问题"
输出：
\`\`\`json
{
  "isComposite": true,
  "subRequirements": [
    {
      "id": "req-1",
      "content": "打卡失败了",
      "normalizedContent": "打卡失败",
      "position": { "start": 0, "end": 5 },
      "type": "skill_task",
      "confidence": 0.9
    },
    {
      "id": "req-2",
      "content": "发票上传也有问题",
      "normalizedContent": "发票上传有问题",
      "position": { "start": 7, "end": 15 },
      "type": "skill_task",
      "confidence": 0.9
    }
  ],
  "overallIntent": "skill_task",
  "metadata": {
    "processingTime": 80,
    "decompositionConfidence": 0.85
  }
}
\`\`\`

### 示例3：上下文引用
输入："那怎么重新提交"
输出：
\`\`\`json
{
  "isComposite": false,
  "subRequirements": [
    {
      "id": "req-1",
      "content": "那怎么重新提交",
      "normalizedContent": "怎么重新提交",
      "position": { "start": 0, "end": 7 },
      "type": "context_reference",
      "confidence": 0.85
    }
  ],
  "overallIntent": "skill_task",
  "metadata": {
    "processingTime": 30,
    "decompositionConfidence": 0.85
  }
}
\`\`\`

### 示例4：闲聊
输入："你好"
输出：
\`\`\`json
{
  "isComposite": false,
  "subRequirements": [],
  "overallIntent": "small_talk",
  "metadata": {
    "processingTime": 10,
    "decompositionConfidence": 0.99
  }
}
\`\`\`

只返回 JSON，不要包含其他解释。
`;

export const DecompositionResponseSchema = z.object({
  isComposite: z.boolean(),
  subRequirements: z.array(z.object({
    id: z.string(),
    content: z.string(),
    normalizedContent: z.string(),
    position: z.object({
      start: z.number(),
      end: z.number(),
    }),
    type: z.enum(['skill_task', 'clarification', 'context_reference']),
    confidence: z.number().min(0).max(1),
  })),
  overallIntent: z.enum(['skill_task', 'small_talk', 'unclear']),
  metadata: z.object({
    processingTime: z.number(),
    decompositionConfidence: z.number().min(0).max(1),
  }),
});

export type DecompositionResponse = z.infer<typeof DecompositionResponseSchema>;

export function buildDecompositionPrompt(requirement: string): string {
  return `请分析以下用户需求，判断是否为复合需求并进行拆解：

用户需求：${requirement}

请返回拆解结果的 JSON 格式。`;
}
