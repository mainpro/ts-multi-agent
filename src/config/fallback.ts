import { readFileSync } from 'fs';
import { join } from 'path';

let globalFallbackContent: string | null = null;

export function getFallbackContent(): string {
  if (!globalFallbackContent) {
    const configFile = process.env.FALLBACK_CONFIG || 'fallback.md';
    const defaultPath = join(process.cwd(), 'config', configFile);

    try {
      globalFallbackContent = readFileSync(defaultPath, 'utf-8');
      console.log(`[FallbackConfig] 加载配置文件: ${defaultPath}`);
    } catch (error) {
      console.warn(`[FallbackConfig] 加载配置文件失败: ${defaultPath}, 使用空配置`);
      globalFallbackContent = '';
    }
  }
  return globalFallbackContent;
}
