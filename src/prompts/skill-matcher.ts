import { SkillMetadata } from '../types';
import { SubRequirement } from '../types/requirement-types';

/**
 * 子需求技能匹配器 SystemPrompt
 *
 * 专门用于单个子需求的技能匹配，比 IntentRouter 的匹配器更精确
 */
export const SUB_REQUIREMENT_MATCHER_PROMPT = `你是一个专业的子需求技能匹配器。你的任务是为单个子需求匹配最合适的技能。

## 匹配原则

1. **精确匹配优先**：如果子需求明确提到某个技能相关的关键词，直接匹配
2. **语义推断**：如果没有直接关键词，根据语义推断可能需要的技能
3. **置信度评估**：
   - 直接匹配：confidence >= 0.9
   - 强语义推断：confidence 0.7-0.9
   - 弱语义推断：confidence 0.5-0.7
   - 无法匹配：confidence < 0.5，返回 none

## 可用技能

{skills_block}

## 输出格式

返回 JSON 格式：
\`\`\`json
{
  "skill": "匹配的技能名称或null",
  "confidence": 0.0-1.0,
  "matchType": "direct" | "inferred" | "none",
  "reasoning": "匹配推理过程（简短说明）"
}
\`\`\`

**重要规则**：
- matchType 为 "none" 时，skill 必须为 null
- reasoning 必须简短，不超过 50 字
- 只返回 JSON，不要包含其他解释
`;

/**
 * 构建子需求匹配提示词
 */
export function buildSubRequirementMatcherPrompt(
  skills: SkillMetadata[],
  subReq: SubRequirement,
  context?: {
    recentSkill?: string;
    conversationContext?: string;
  }
): { systemPrompt: string; userPrompt: string } {
  // 构建技能列表
  const skillsBlock = skills
    .filter(s => !s.hidden)
    .map(s => `- **${s.name}**: ${s.description}`)
    .join('\n');

  const systemPrompt = SUB_REQUIREMENT_MATCHER_PROMPT.replace(
    '{skills_block}',
    skillsBlock || '暂无可用技能'
  );

  // 构建用户提示词
  let userPrompt = `【子需求内容】\n${subReq.content}\n\n`;
  userPrompt += `【标准化内容】\n${subReq.normalizedContent}\n\n`;

  if (context?.recentSkill) {
    userPrompt += `【上下文提示】\n最近使用的技能: ${context.recentSkill}\n\n`;
  }

  if (context?.conversationContext) {
    userPrompt += `【对话上下文】\n${context.conversationContext}\n\n`;
  }

  userPrompt += `请为这个子需求匹配最合适的技能。`;

  return { systemPrompt, userPrompt };
}

/**
 * 批量匹配的 SystemPrompt
 *
 * 用于一次性匹配多个子需求，减少 LLM 调用次数
 */
export const BATCH_MATCHER_PROMPT = `你是一个专业的批量子需求技能匹配器。你的任务是为多个子需求同时匹配技能。

## 匹配原则

1. **独立匹配**：每个子需求独立匹配，不考虑其他子需求的影响
2. **精确匹配优先**：如果子需求明确提到某个技能相关的关键词，直接匹配
3. **语义推断**：如果没有直接关键词，根据语义推断可能需要的技能
4. **置信度评估**：
   - 直接匹配：confidence >= 0.9
   - 强语义推断：confidence 0.7-0.9
   - 弱语义推断：confidence 0.5-0.7
   - 无法匹配：confidence < 0.5，返回 none

## 可用技能

{skills_block}

## 输出格式

返回 JSON 数组，每个元素对应一个子需求：
\`\`\`json
[
  {
    "subReqId": "子需求ID",
    "skill": "匹配的技能名称或null",
    "confidence": 0.0-1.0,
    "matchType": "direct" | "inferred" | "none",
    "reasoning": "匹配推理过程（简短说明）"
  }
]
\`\`\`

**重要规则**：
- 数组长度必须与输入的子需求数量一致
- matchType 为 "none" 时，skill 必须为 null
- reasoning 必须简短，不超过 50 字
- 只返回 JSON 数组，不要包含其他解释
`;

/**
 * 构建批量匹配提示词
 */
export function buildBatchMatcherPrompt(
  skills: SkillMetadata[],
  subReqs: SubRequirement[]
): { systemPrompt: string; userPrompt: string } {
  // 构建技能列表
  const skillsBlock = skills
    .filter(s => !s.hidden)
    .map(s => `- **${s.name}**: ${s.description}`)
    .join('\n');

  const systemPrompt = BATCH_MATCHER_PROMPT.replace(
    '{skills_block}',
    skillsBlock || '暂无可用技能'
  );

  // 构建用户提示词
  const subReqsList = subReqs
    .map((sr, index) => {
      return `${index + 1}. [ID: ${sr.id}]\n   内容: ${sr.content}\n   标准化: ${sr.normalizedContent}`;
    })
    .join('\n\n');

  const userPrompt = `【子需求列表】\n共 ${subReqs.length} 个子需求：\n\n${subReqsList}\n\n请为每个子需求匹配最合适的技能。`;

  return { systemPrompt, userPrompt };
}

export default {
  SUB_REQUIREMENT_MATCHER_PROMPT,
  BATCH_MATCHER_PROMPT,
  buildSubRequirementMatcherPrompt,
  buildBatchMatcherPrompt,
};
