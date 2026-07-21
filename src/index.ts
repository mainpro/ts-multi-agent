import * as dotenv from 'dotenv';
import { resolveResource } from './utils/app-root';
dotenv.config({ path: resolveResource('.env') });

import { SkillRegistry } from './skill-registry';
import { TaskQueue } from './task-queue';
import { LLMClient } from './llm';
import { MainAgent, MainAgentDependencies } from './agents/main-agent';
import { SubAgent } from './agents/sub-agent';
import { createAPIServer } from './api';
import { Task, TaskResult } from './types';
import { MemoryService } from './memory/memory-service';
import { IntentRouter } from './routers';
import { UserProfileService } from './user-profile';
import { DynamicContextBuilder } from './context/dynamic-context';
import { sessionContextService } from './memory';
import { SessionStore } from './memory/session-store';
import { migrateMemoryIfNeeded } from './memory/migrate';
import { AskAgent } from './agents/ask-agent';
import { SystemSkillLoader, ExecutorRegistry } from './system-skills';

// 端口优先级：命令行参数 > 环境变量 > 默认值 3000
function getPort(): number {
  const cliArg = process.argv.find(arg => arg.startsWith('--port='));
  if (cliArg) {
    const port = parseInt(cliArg.split('=')[1], 10);
    if (!isNaN(port) && port > 0 && port <= 65535) return port;
  }
  if (process.env.PORT) {
    const port = parseInt(process.env.PORT, 10);
    if (!isNaN(port) && port > 0 && port <= 65535) return port;
  }
  return 3000;
}

const PORT = getPort();
const SKILL_DIR = process.env.SKILL_DIR || resolveResource('skills');
const DATA_DIR = process.env.DATA_DIR || resolveResource('data');

let skillRegistry: SkillRegistry;
let taskQueue: TaskQueue;
let memoryServiceInstance: MemoryService;

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
      console.warn('⚠️  Warning: Failed to initialize LLM Client. Set NVIDIA_API_KEY env var.\n');
      process.exit(1);
    }

    // 2. Create Skill Registry
    console.log('📚 Initializing Skill Registry...');
    skillRegistry = new SkillRegistry();

    // 3. Scan skills
    console.log(`🔍 Scanning skills from ${SKILL_DIR}...`);
    await skillRegistry.scanSkills(SKILL_DIR);
    const skillCount = skillRegistry.getSkillCount();
    console.log(`✅ Found ${skillCount} skill${skillCount !== 1 ? 's' : ''}\n`);

    // P2-3: 启动技能热重载
    skillRegistry.startWatch();

    if (skillCount > 0) {
      console.log('Registered skills:');
      for (const name of skillRegistry.getSkillNames()) {
        const metadata = skillRegistry.getSkillMetadata(name);
        console.log(`  - ${name}: ${metadata?.description || 'No description'}`);
      }
      console.log();
    }

    // 4. Create shared MemoryService (用于 SubAgent 和 MainAgent)
    console.log('🧠 Initializing MemoryService...');

    // 4.1 数据迁移(启动时一次性)
    await migrateMemoryIfNeeded(DATA_DIR);

    const memoryService = new MemoryService(DATA_DIR, llmClient);
    memoryServiceInstance = memoryService;
    console.log('✅ MemoryService initialized\n');

    // 5. Create SubAgent
    console.log('🤖 Initializing SubAgent...');
    const subAgent = new SubAgent(skillRegistry, llmClient, memoryService);
    console.log('✅ SubAgent initialized\n');

    // 6. Create Task Queue with SubAgent as executor
    console.log('📋 Initializing Task Queue...');
    taskQueue = new TaskQueue(async (task: Task): Promise<unknown> => {
      const result: TaskResult = await subAgent.execute(task);
      if (!result.success) {
        throw new Error(result.error?.message || 'Task execution failed');
      }
      return result;
    });
    console.log('✅ Task Queue initialized\n');

    // 7. 创建所有 MainAgent 依赖（DI 模式）
    console.log('🔧 Creating MainAgent dependencies...');
    const intentRouter = new IntentRouter(llmClient, skillRegistry);
    const userProfileService = new UserProfileService(DATA_DIR);
    const dynamicContextBuilder = new DynamicContextBuilder(memoryService);
    const sessionStore = new SessionStore();
    const askAgent = new AskAgent(sessionStore, llmClient);
    const systemSkillLoader = new SystemSkillLoader();
    systemSkillLoader.loadAll();
    const executorRegistry = new ExecutorRegistry();
    console.log('✅ All dependencies created\n');

    // 8. Create MainAgent（通过 DI 注入所有依赖）
    console.log('🧠 Initializing MainAgent...');
    const mainAgentDeps: MainAgentDependencies = {
      llm: llmClient,
      skillRegistry,
      taskQueue,
      intentRouter,
      userProfileService,
      memoryService,
      dynamicContextBuilder,
      sessionStore,
      askAgent,
      systemSkillLoader,
      executorRegistry,
    };
    const mainAgent = new MainAgent(mainAgentDeps);
    console.log('✅ MainAgent initialized\n');

    // 9. Create and start API Server
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

// #3/#18: 资源清理函数（不退出进程）
async function cleanupResources(): Promise<void> {
  try {
    taskQueue?.clear();
  } catch (e) {
    // ignore
  }
  try {
    sessionContextService?.stop();
  } catch (e) {
    // ignore
  }
  try {
    skillRegistry?.stopWatch();
  } catch (e) {
    // ignore
  }
  // flush L4 history 所有 pending 写入
  try {
    if (memoryServiceInstance) {
      await memoryServiceInstance.flushAll();
    }
  } catch (e) {
    // ignore
  }
}

// #3/#18: 优雅关闭函数
async function gracefulShutdown(exitCode: number = 0): Promise<void> {
  console.log('[Shutdown] Graceful shutdown initiated...');
  await cleanupResources();
  process.exit(exitCode);
}

process.on('uncaughtException', async (error) => {
  console.error('❌ Uncaught Exception:', error);
  await gracefulShutdown(1);
});

// #3: 记录后让进程继续运行，但清理资源保持一致
process.on('unhandledRejection', async (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  await cleanupResources();
});

process.on('SIGTERM', () => {
  gracefulShutdown(0);
});

bootstrap();
