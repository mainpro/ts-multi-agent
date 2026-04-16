/**
 * 指标采集
 * P2-1: 结构化日志与指标
 */

export class MetricsCollector {
  private counters: Map<string, number> = new Map();
  private histograms: Map<string, number[]> = new Map();
  private gauges: Map<string, number> = new Map();

  incrementCounter(name: string, value: number = 1): void {
    this.counters.set(name, (this.counters.get(name) || 0) + value);
  }

  decrementCounter(name: string, value: number = 1): void {
    this.counters.set(name, (this.counters.get(name) || 0) - value);
  }

  recordHistogram(name: string, value: number): void {
    if (!this.histograms.has(name)) {
      this.histograms.set(name, []);
    }
    const values = this.histograms.get(name)!;
    values.push(value);
    // 保留最近 1000 个数据点
    if (values.length > 1000) {
      values.shift();
    }
  }

  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  getCounter(name: string): number {
    return this.counters.get(name) || 0;
  }

  /**
   * 输出 Prometheus 格式指标
   */
  toPrometheus(): string {
    let output = '';

    for (const [name, value] of this.counters) {
      output += `# HELP ${name}\n# TYPE ${name} counter\n${name} ${value}\n`;
    }

    for (const [name, values] of this.histograms) {
      if (values.length === 0) continue;
      const sorted = [...values].sort((a, b) => a - b);
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      const p50 = sorted[Math.floor(sorted.length * 0.5)];
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      const p99 = sorted[Math.floor(sorted.length * 0.99)];

      output += `# HELP ${name}_avg\n# TYPE ${name}_avg gauge\n${name}_avg ${avg.toFixed(2)}\n`;
      output += `# HELP ${name}_p50\n# TYPE ${name}_p50 gauge\n${name}_p50 ${p50}\n`;
      output += `# HELP ${name}_p95\n# TYPE ${name}_p95 gauge\n${name}_p95 ${p95}\n`;
      output += `# HELP ${name}_p99\n# TYPE ${name}_p99 gauge\n${name}_p99 ${p99}\n`;
    }

    for (const [name, value] of this.gauges) {
      output += `# HELP ${name}\n# TYPE ${name} gauge\n${name} ${value}\n`;
    }

    return output;
  }

  /**
   * 重置所有指标
   */
  reset(): void {
    this.counters.clear();
    this.histograms.clear();
    this.gauges.clear();
  }
}

// 全局单例
export const metrics = new MetricsCollector();
