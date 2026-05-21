/**
 * AskUserTool - 向用户询问信息的工具
 *
 * 允许 LLM 显式声明需要向用户提问，替代文本检测方式
 * 支持多种提问类型：文本、选择、确认、数字、日期
 */

import { Tool, ToolContext, ToolResult, ToolParameters } from './interfaces';

export interface AskUserArgs {
  /** 问题内容 */
  question: string;
  /** 期望的用户回复类型 */
  expectedType?: 'text' | 'choice' | 'confirm' | 'number' | 'date';
  /** 选项列表（当 expectedType=choice 时使用） */
  options?: string[];
  /** 参数名（如"employeeId"），用于自动填充 */
  paramName?: string;
  /** 是否阻塞等待用户回复 */
  isBlocking?: boolean;
  /** 额外的上下文信息 */
  context?: string;
}

export class AskUserTool implements Tool {
  name = 'ask_user';

  description = `当你需要向用户询问信息才能继续完成任务时，必须调用此工具。

使用场景：
- 缺少必需参数（如工号、系统名称、时间范围）
- 需要用户确认（如"是否继续删除？"）
- 需要用户选择（如"请选择要查询的系统：A、B、C"）

禁止调用场景：
- 你已经从工具结果或上下文中获得了所需信息
- 你只是在陈述结果或解释说明

使用示例：
1. 需要确认：
   { "question": "确定要删除该记录吗？", "expectedType": "confirm", "paramName": "confirmed" }

2. 需要选择：
   { "question": "请选择系统", "expectedType": "choice", "options": ["OA", "ERP"], "paramName": "system" }

3. 需要文本：
   { "question": "请提供您的工号", "expectedType": "text", "paramName": "employeeId" }`;

  // 使用扁平结构符合 ToolParameters 接口
  parameters: ToolParameters = {
    question: { type: 'string', description: '向用户提出的问题，要求简洁明确，说明为什么需要这个信息' },
    expectedType: { type: 'string', description: '期望的用户回复类型: text(文本)/choice(选择)/confirm(确认)/number(数字)/date(日期)' },
    options: { type: 'string', description: '选项列表，当 expectedType=choice 时使用，用逗号分隔多个选项' },
    paramName: { type: 'string', description: '此信息对应的参数名（如"employeeId"），用于系统自动填充' },
    isBlocking: { type: 'string', description: '是否阻塞等待用户回复，默认 true' },
    context: { type: 'string', description: '额外的上下文信息，帮助用户理解问题背景' },
  };

  required = ['question'];

  async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
    const args = input as AskUserArgs;

    // 参数校验
    if (!args.question || args.question.trim().length === 0) {
      return {
        success: false,
        error: 'question 不能为空'
      };
    }

    // choice 类型必须有 options
    if (args.expectedType === 'choice' && (!args.options || args.options.length === 0)) {
      return {
        success: false,
        error: 'expectedType 为 choice 时，必须提供 options 选项列表'
      };
    }

    // 工具本身不执行实际操作，返回特殊标记由 SubAgent 拦截处理
    return {
      success: true,
      data: {
        __ask_user__: true,
        question: args.question,
        expectedType: args.expectedType || 'text',
        options: args.options,
        paramName: args.paramName,
        isBlocking: args.isBlocking ?? true,
        context: args.context
      }
    };
  }

  isReadOnly(): boolean {
    return true;  // 不修改系统状态
  }

  isConcurrencySafe(): boolean {
    return true;  // 可并发执行
  }
}
