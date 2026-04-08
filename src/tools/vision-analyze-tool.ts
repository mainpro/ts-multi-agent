/**
 * VisionAnalyzeTool - Tool for analyzing images using vision models
 * 
 * This tool provides image analysis functionality using GLM-4V-Flash API,
 * extracting system information, error types, and suggested actions from screenshots.
 * 
 * Based on Claude Code's tool system design
 */

import { BaseTool } from './base-tool';
import { VisionLLMClient } from '../llm/vision-client';
import type { ToolContext, ToolResult } from './interfaces';

/**
 * Input parameters for VisionAnalyzeTool
 */
export interface VisionAnalyzeInput {
  /** Base64 encoded image data */
  imageBase64: string;
  /** MIME type of the image (e.g., "image/png", "image/jpeg") */
  mimeType: string;
  /** Optional custom prompt for analysis */
  prompt?: string;
}

/**
 * VisionAnalyzeTool - Analyzes images using vision models
 * 
 * Features:
 * - Extracts system information from screenshots
 * - Identifies error types and severity
 * - Provides suggested actions
 * - Concurrency-safe (read-only operation, no side effects)
 * - Uses GLM-4V-Flash for image analysis
 */
export class VisionAnalyzeTool extends BaseTool {
  name = 'vision_analyze';
  description = 'Analyze an image using vision models. Extracts system information, error types, and suggests actions from screenshots.';
  
  private visionClient: VisionLLMClient;

  constructor() {
    super();
    this.visionClient = new VisionLLMClient();
  }

  async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
    try {
      const params = this.validateInput(input);
      
      console.log(`[VisionAnalyzeTool] 🔍 Analyzing image (${params.mimeType})...`);
      
      const result = await this.visionClient.analyzeImage(
        params.imageBase64,
        params.mimeType,
        params.prompt
      );

      console.log(`[VisionAnalyzeTool] ✅ Analysis complete: ${result.system || 'unknown system'}`);

      return {
        success: true,
        data: {
          system: result.system,
          errorType: result.errorType,
          description: result.description,
          suggestedAction: result.suggestedAction,
        },
      };
    } catch (error) {
      console.error(`[VisionAnalyzeTool] ❌ Analysis failed:`, error);
      return {
        success: false,
        error: this.formatError(error),
      };
    }
  }

  /**
   * Vision analysis is safe to run concurrently
   * It's a read-only operation with no side effects
   */
  isConcurrencySafe(_input: unknown): boolean {
    return true;
  }

  /**
   * Vision analysis only reads the image and returns analysis
   * It doesn't modify any state
   */
  isReadOnly(): boolean {
    return true;
  }

  private validateInput(input: unknown): VisionAnalyzeInput {
    if (!input || typeof input !== 'object') {
      throw new Error('Input must be an object');
    }

    const params = input as Record<string, unknown>;

    if (!params.imageBase64 || typeof params.imageBase64 !== 'string') {
      throw new Error('imageBase64 is required and must be a string');
    }

    if (!params.mimeType || typeof params.mimeType !== 'string') {
      throw new Error('mimeType is required and must be a string');
    }

    return {
      imageBase64: params.imageBase64,
      mimeType: params.mimeType,
      prompt: typeof params.prompt === 'string' ? params.prompt : undefined,
    };
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      const message = error.message;
      if (message.includes('ZHIPU_API_KEY')) {
        return 'Vision analysis failed: ZHIPU_API_KEY not configured. Please set the ZHIPU_API_KEY environment variable.';
      }
      if (message.includes('timeout')) {
        return 'Vision analysis failed: Request timed out. The image may be too large or the service is slow.';
      }
      if (message.includes('rate limit')) {
        return 'Vision analysis failed: Rate limit exceeded. Please try again later.';
      }
      return `Vision analysis failed: ${message}`;
    }
    return `Vision analysis failed: ${String(error)}`;
  }
}
