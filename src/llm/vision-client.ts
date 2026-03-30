import { LLMError } from './index';

/**
 * Vision analysis result structure
 */
export interface VisionAnalysisResult {
  /** System identifier (e.g., "GEAM" or "其他系统") */
  system?: string;
  /** Error type classification (e.g., "权限错误/登录错误/系统错误/无错误") */
  errorType?: string;
  /** Detailed description of the image content */
  description: string;
  /** Suggested action based on analysis */
  suggestedAction?: string;
}

/**
 * Zod schema for VisionAnalysisResult validation
 */
import { z } from 'zod';

export const VisionAnalysisResultSchema = z.object({
  system: z.string().optional(),
  errorType: z.string().optional(),
  description: z.string(),
  suggestedAction: z.string().optional(),
});

/**
 * Vision LLM client for analyzing images using GLM-4V-Flash API
 */
export class VisionLLMClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;
  private maxRetries: number;

  private static readonly SYSTEM_PROMPT = `你是专业的应用系统运维工程师。请分析这张应用运维界面截图，包括监控面板、告警信息、接口指标、日志、服务状态等。

请按以下要求输出：
1. 截图中的关键信息：系统名称、模块、指标、时间、异常颜色标识。
2. 识别异常：错误率、响应延迟、QPS波动、连接异常、服务下线、报错信息等。
3. 异常等级：正常 / 一般 / 严重 / 致命。
4. 可能原因（按可能性从高到低）。
5. 可直接执行的排查与处理步骤。
6. 对业务的影响范围。

语言专业、简洁、符合运维实际，不编造不存在的信息。

返回 JSON 格式：
{
  "system": "XXX系统/域名",
  "errorType": "权限错误/登录错误/系统错误/无错误",
  "description": "图片内容的详细描述",
  "suggestedAction": "建议的处理方式"
}`;

  /**
   * Create a new Vision LLM client
   * @param apiKey - Zhipu API key (defaults to ZHIPU_API_KEY env var)
   */
  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.ZHIPU_API_KEY || '';
    this.baseUrl = 'https://open.bigmodel.cn/api/paas/v4';
    this.model = 'glm-4v-flash';
    this.timeoutMs = 120000;
    this.maxRetries = 3;

    if (!this.apiKey) {
      throw new LLMError(
        'INVALID_KEY',
        'ZHIPU_API_KEY environment variable is not set'
      );
    }
  }

  /**
   * Calculate delay for exponential backoff
   * @param attempt - Current attempt number (0-indexed)
   * @returns Delay in milliseconds
   */
  private getRetryDelay(attempt: number): number {
    return Math.pow(2, attempt) * 1000;
  }

  /**
   * Sleep for a given duration
   * @param ms - Milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Analyze an image using the GLM-4V-Flash API
   * @param imageBase64 - Base64 encoded image data
   * @param mimeType - MIME type of the image (e.g., "image/png", "image/jpeg")
   * @param prompt - Optional custom prompt (defaults to system prompt)
   * @returns Structured analysis result
   */
  async analyzeImage(
    imageBase64: string,
    mimeType: string,
    prompt?: string
  ): Promise<VisionAnalysisResult> {
    let lastError: LLMError | undefined;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        console.log(`Vision LLM request attempt ${attempt + 1}/${this.maxRetries}`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          console.log('Vision LLM request timeout');
          controller.abort();
        }, this.timeoutMs);

        const requestBody = {
          model: this.model,
          messages: [
            {
              role: 'system',
              content: VisionLLMClient.SYSTEM_PROMPT,
            },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: prompt || '请分析这张图片',
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${mimeType};base64,${imageBase64}`,
                  },
                },
              ],
            },
          ],
          temperature: 0.3,
          response_format: { type: 'json_object' },
        };

        console.log('Sending Vision LLM request to:', `${this.baseUrl}/chat/completions`);

        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        console.log('Vision LLM request response status:', response.status);

        const data = await response.json() as Record<string, unknown>;
        console.log('Vision LLM request response data:', JSON.stringify(data, null, 2));

        if (data.error) {
          const err = data.error as Record<string, unknown>;
          console.log('Vision LLM API error:', err);
          throw new LLMError(
            'API_ERROR',
            (err.message as string) || 'Unknown API error',
            response.status
          );
        }

        if (!response.ok) {
          console.log('Vision LLM request not ok:', response.status);
          throw new LLMError(
            'API_ERROR',
            `Request failed with status ${response.status}`,
            response.status
          );
        }

        const choices = data.choices as Array<Record<string, unknown>> | undefined;
        if (!choices || choices.length === 0) {
          throw new LLMError('API_ERROR', 'No choices in response');
        }

        const message = choices[0].message as Record<string, unknown> | undefined;
        const content = message?.content;

        if (!content || typeof content !== 'string') {
          throw new LLMError('API_ERROR', 'No content in response');
        }

        console.log('Vision LLM request successful');

        try {
          const parsed = JSON.parse(content);
          return VisionAnalysisResultSchema.parse(parsed);
        } catch (parseError) {
          throw new LLMError(
            'API_ERROR',
            `Failed to parse JSON response: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`,
            undefined,
            parseError
          );
        }
      } catch (error) {
        console.log('Vision LLM request error:', error);

        if (error instanceof LLMError) {
          lastError = error;

          // Don't retry on invalid key
          if (error.type === 'INVALID_KEY') {
            console.log('Invalid API key, throwing error');
            throw error;
          }

          // Check if this is the last attempt
          if (attempt === this.maxRetries - 1) {
            console.log('Last attempt failed, throwing error');
            throw error;
          }
        } else if (error instanceof Error) {
          if (error.name === 'AbortError') {
            lastError = new LLMError(
              'TIMEOUT',
              `Request timeout after ${this.timeoutMs}ms`,
              undefined,
              error
            );

            if (attempt === this.maxRetries - 1) {
              console.log('Request timeout, throwing error');
              throw lastError;
            }
          } else {
            lastError = new LLMError(
              'NETWORK_ERROR',
              `Network error: ${error.message}`,
              undefined,
              error
            );

            if (attempt === this.maxRetries - 1) {
              console.log('Network error, throwing error');
              throw lastError;
            }
          }
        } else {
          lastError = new LLMError(
            'UNKNOWN_ERROR',
            'Unknown error occurred',
            undefined,
            error
          );

          if (attempt === this.maxRetries - 1) {
            console.log('Unknown error, throwing error');
            throw lastError;
          }
        }

        // Wait before retrying (exponential backoff)
        const delay = this.getRetryDelay(attempt);
        console.log(`Waiting ${delay}ms before retrying`);
        await this.sleep(delay);
      }
    }

    // This should never be reached, but just in case
    console.log('All retry attempts failed');
    throw lastError || new LLMError('UNKNOWN_ERROR', 'Request failed after all retries');
  }
}

/**
 * Create a default Vision LLM client instance
 * @returns VisionLLMClient instance
 */
export function createVisionLLMClient(): VisionLLMClient {
  return new VisionLLMClient();
}
