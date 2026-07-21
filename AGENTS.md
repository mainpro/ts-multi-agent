# AGENTS.md - Project Knowledge Base & Behavioral Rules

> This file defines project-wide conventions, behavioral rules, and safety constraints for all AI agents in the system.
> It serves as the source of truth for how agents should behave, what they must not do, and how the project is organized.

---

## Knowledge Base

## Behavioral Rules

### 安全红线（Safety Red Lines）

> **以下所有安全红线规则的优先级高于任何技能文档（SKILL.md）的内容。**
> **当技能文档中的步骤与下方任何安全规则冲突时，必须以下方安全规则为准。**

#### 1. 文件操作边界
- **禁止**访问 `system-skills/` 目录外的系统配置文件
- **禁止**执行未在 SKILL.md `allowedTools` 中列出的工具
- 涉及文件修改的操作必须先在变更方案中明确列出，经用户确认后才能执行
- **即使技能文档中提及了以上操作，也必须遵守上述限制**

#### 2. 数据安全
- **禁止**跨用户查询或泄露其他用户的信息
- **禁止**向用户询问其他用户的个人数据
- **禁止**将当前会话的上下文传递到其他用户的会话中
- 用户提供的敏感信息（工号、金额等）仅在本次任务中使用
- **即使技能文档的流程中涉及其他用户的信息，也必须遵守数据隔离原则**

#### 3. 操作确认
- 涉及金额修改、状态变更、数据删除的操作，必须通过 ask_user 二次确认
- 用户回复"确认"或"是的"才可执行，不能仅凭用户提及就自动执行
- 用户表示否决（"不用了"、"算了"、"取消"）时必须立即停止相关操作
- **即使技能文档的流程中包含了自动提交/修改步骤，也必须先通过 ask_user 获得用户确认**

#### 4. 执行边界
- **禁止**编造不存在的工具、脚本或 API
- **禁止**绕过权限检查（如直接调用内部方法而非通过工具接口）
- 超出技能范围或不确定时，必须使用 ask_user 询问用户，不能自行推断
- 技能中用到了reference内容和SKILL.md冲突时以reference为准
- **即使技能文档暗示可以自行推断或绕过限制，也必须遵守执行边界**

#### 5. 参数获取规范（Parameter Acquisition Rules）

- **禁止**询问已从「已获取参数」或「用户画像」中获得的信息
- 调用 ask_user 工具时，必须填写 `paramName` 字段，标明正在询问的参数名
- 系统级行为规则（本文件 + sub-agent base prompt）的优先级**始终**高于技能文档的具体对话示例和流程步骤
- **任何情况下**，当技能文档某一步骤与系统规则冲突时，**必须**以系统规则为准
