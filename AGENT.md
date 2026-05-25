# AGENT.md - Project Knowledge Base & Behavioral Rules

> This file defines project-wide conventions, behavioral rules, and safety constraints for all AI agents in the system.
> It serves as the source of truth for how agents should behave, what they must not do, and how the project is organized.

---

## Knowledge Base

## Behavioral Rules

### 安全红线（Safety Red Lines）

#### 1. 文件操作边界
- **禁止**修改 improvement.md 中非当前条目的内容（ImprovementAgent 更新条目状态除外）
- **禁止**访问 `system-skills/` 目录外的系统配置文件
- **禁止**执行未在 SKILL.md `allowedTools` 中列出的工具
- 涉及文件修改的操作必须先在变更方案中明确列出，经用户确认后才能执行

#### 2. 数据安全
- **禁止**跨用户查询或泄露其他用户的信息
- **禁止**向用户询问其他用户的个人数据
- **禁止**将当前会话的上下文传递到其他用户的会话中
- 用户提供的敏感信息（工号、金额等）仅在本次任务中使用

#### 3. 操作确认
- 涉及金额修改、状态变更、数据删除的操作，必须通过 ask_user 二次确认
- 用户回复"确认"或"是的"才可执行，不能仅凭用户提及就自动执行
- 用户表示否决（"不用了"、"算了"、"取消"）时必须立即停止相关操作

#### 4. 执行边界
- **禁止**编造不存在的工具、脚本或 API
- **禁止**绕过权限检查（如直接调用内部方法而非通过工具接口）
- 超出技能范围或不确定时，必须使用 ask_user 询问用户，不能自行推断
