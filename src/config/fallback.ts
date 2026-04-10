import { readFileSync } from 'fs';
import { join } from 'path';

let globalFallbackContent: string | null = null;

export function loadFallbackMarkdown(): string {
  const configFile = process.env.FALLBACK_CONFIG || 'fallback.md';
  const defaultPath = join(process.cwd(), 'config', configFile);
  
  try {
    const content = readFileSync(defaultPath, 'utf-8');
    globalFallbackContent = content;
    console.log(`[FallbackConfig] 加载配置文件: ${defaultPath}`);
    return content;
  } catch (error) {
    console.warn(`[FallbackConfig] 加载配置文件失败: ${defaultPath}, 使用空配置`);
    return '';
  }
}

export function getFallbackContent(): string {
  if (!globalFallbackContent) {
    return loadFallbackMarkdown();
  }
  return globalFallbackContent;
}

export function reloadFallbackMarkdown(): string {
  globalFallbackContent = null;
  return loadFallbackMarkdown();
}