import { Session } from '../types';

/**
 * 将 Session 结构转为 LLM 系统提示词
 *
 * 让 LLM 提前理解当前会话状态、询问历史、挂起请求
 */
export function buildSessionPrompt(session: Session): string {
  const parts: string[] = ['## 当前会话状态'];

  const activeRequest = session.requests.find(r => r.requestId === session.activeRequestId);

  if (activeRequest) {
    parts.push('### 活跃请求');
    parts.push(`- 请求ID: ${activeRequest.requestId}`);
    parts.push(`- 内容: "${activeRequest.content}"`);
    parts.push(`- 状态: ${activeRequest.status}`);

    if (activeRequest.questions.length > 0) {
      parts.push('- 询问历史:');
      activeRequest.questions.forEach((q, i) => {
        const source = q.source === 'main_agent' ? '主智能体' : '子智能体';
        parts.push(`  ${i + 1}. [${source}] "${q.content}" → "${q.answer || '(等待回答)'}"`);
      });
    }

    if (activeRequest.tasks.length > 0) {
      parts.push('- 子任务:');
      activeRequest.tasks.forEach(t => {
        parts.push(`  - ${t.taskId} [${t.skillName || '未知'}] ${t.status}`);
        if (t.questions.length > 0) {
          t.questions.forEach((q, i) => {
            parts.push(`    - 询问${i + 1}: "${q.content}" → "${q.answer || '(等待回答)'}"`);
          });
        }
      });
    }
  }

  const suspendedRequests = session.requests.filter(r => r.status === 'suspended');
  if (suspendedRequests.length > 0) {
    parts.push('### 挂起的请求');
    suspendedRequests.forEach(r => {
      parts.push(`- 请求ID: ${r.requestId}`);
      parts.push(`- 内容: "${r.content}"`);
      parts.push(`- 挂起原因: ${r.suspendedReason || '未知'}`);
    });
  }

  return parts.join('\n');
}
