import { createLogger } from '../observability/logger';

const log = createLogger({ module: 'SteeringBuffer' });

export interface SteeringMessage {
  content: string;
  enqueuedAt: string;
}

/**
 * 进程内的用户改口缓冲区(steer queue)
 *
 * 与 SessionGate.pendingRequests 的区别:
 * - pendingRequests: 跨 request 边界,等 checkpoint 合并 → 长延迟
 * - steeringBuffer:  当前 turn 边界插入,几乎实时
 *
 * 不持久化:进程重启后丢失可接受(steer 是实时语义)
 *
 * 参考 OpenClaw packages/agent-core/src/harness/agent-harness.ts steer()
 */
class SteeringBuffer {
  private buffers = new Map<string, SteeringMessage[]>();

  enqueue(sessionId: string, msg: SteeringMessage): void {
    const queue = this.buffers.get(sessionId) || [];
    queue.push(msg);
    this.buffers.set(sessionId, queue);
    log.info('steering 消息入队', {
      sessionId,
      content: msg.content.substring(0, 50),
      queueSize: queue.length,
    });
  }

  /**
   * 取出并清空指定 session 的所有 steering 消息
   */
  consume(sessionId: string): SteeringMessage[] {
    const queue = this.buffers.get(sessionId) || [];
    this.buffers.set(sessionId, []);
    return queue;
  }

  /**
   * 查看但不消费(返回副本,外部修改不影响内部队列)
   */
  peek(sessionId: string): SteeringMessage[] {
    return [...(this.buffers.get(sessionId) || [])];
  }

  clear(sessionId: string): void {
    this.buffers.delete(sessionId);
  }
}

export const steeringBuffer = new SteeringBuffer();
