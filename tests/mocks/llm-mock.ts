// Mock LLM 客户端
export class MockLLMClient {
  async generateText(prompt: string): Promise<string> {
    return 'mock response';
  }
}
