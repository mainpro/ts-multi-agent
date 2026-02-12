import { SkillRegistry } from './skill-registry';
import { TaskQueue } from './task-queue';
import { LLMClient } from './llm';
import { MainAgent } from './agents/main-agent';
import { SubAgent } from './agents/sub-agent';
import { createAPIServer } from './api';
import { Task, TaskResult } from './types';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const SKILL_DIR = process.env.SKILL_DIR || './skills';

async function bootstrap() {
  try {
    console.log('🚀 Starting Multi-Agent System...\n');

    // 1. Create LLM Client
    console.log('📡 Initializing LLM Client...');
    let llmClient: LLMClient;
    try {
      llmClient = new LLMClient();
      console.log('✅ LLM Client initialized\n');
    } catch (error) {
      console.warn('⚠️  Warning: Failed to initialize LLM Client. Set ZHIPU_API_KEY env var.\n');
      process.exit(1);
    }

    // 2. Create Skill Registry
    console.log('📚 Initializing Skill Registry...');
    const skillRegistry = new SkillRegistry();

    // 3. Scan skills
    console.log(`🔍 Scanning skills from ${SKILL_DIR}...`);
    await skillRegistry.scanSkills(SKILL_DIR);
    const skillCount = skillRegistry.getSkillCount();
    console.log(`✅ Found ${skillCount} skill${skillCount !== 1 ? 's' : ''}\n`);

    if (skillCount > 0) {
      console.log('Registered skills:');
      for (const name of skillRegistry.getSkillNames()) {
        const metadata = skillRegistry.getSkillMetadata(name);
        console.log(`  - ${name}: ${metadata?.description || 'No description'}`);
      }
      console.log();
    }

    // 4. Create SubAgent
    console.log('🤖 Initializing SubAgent...');
    const subAgent = new SubAgent(skillRegistry, llmClient);
    console.log('✅ SubAgent initialized\n');

    // 5. Create Task Queue with SubAgent as executor
    console.log('📋 Initializing Task Queue...');
    const taskQueue = new TaskQueue(async (task: Task): Promise<unknown> => {
      const result: TaskResult = await subAgent.execute(task);
      if (!result.success) {
        throw new Error(result.error?.message || 'Task execution failed');
      }
      return result.data;
    });
    console.log('✅ Task Queue initialized\n');

    // 6. Create MainAgent
    console.log('🧠 Initializing MainAgent...');
    const mainAgent = new MainAgent(llmClient, skillRegistry, taskQueue);
    console.log('✅ MainAgent initialized\n');

    // 7. Create and start API Server
    console.log('🌐 Starting API Server...');
    const app = createAPIServer(mainAgent, skillRegistry, taskQueue);
    
    app.listen(PORT, () => {
      console.log('\n' + '='.repeat(50));
      console.log('✨ Multi-Agent System is running!');
      console.log('='.repeat(50));
      console.log(`\n📍 API Endpoint: http://localhost:${PORT}`);
      console.log(`🧪 Test Page: http://localhost:${PORT}/test.html`);
      console.log(`\n📚 Available Endpoints:`);
      console.log(`   GET  /health          - Health check`);
      console.log(`   GET  /skills          - List all skills`);
      console.log(`   POST /tasks           - Submit new task`);
      console.log(`   GET  /tasks/:id       - Get task status`);
      console.log(`   GET  /tasks/:id/result - Get task result`);
      console.log(`   DELETE /tasks/:id     - Cancel task`);
      console.log(`\n⚙️  Configuration:`);
      console.log(`   Skills directory: ${SKILL_DIR}`);
      console.log(`   Port: ${PORT}`);
      console.log(`\n🛑 Press Ctrl+C to stop\n`);
    });

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
  process.exit(1);
});

bootstrap();
