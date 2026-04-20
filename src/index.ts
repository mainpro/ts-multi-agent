import * as dotenv from 'dotenv';
dotenv.config();

import { SkillRegistry } from './skill-registry';
import { TaskQueue } from './task-queue';
import { LLMClient } from './llm';
import { MainAgent } from './agents/main-agent';
import { SubAgent } from './agents/sub-agent';
import { CriticAgent } from './agents/critic-agent';
import { createAPIServer } from './api';
import { Task, TaskResult } from './types';
import { logManager } from './observability/log-manager';
import { reportGenerator } from './reports/report-generator';
import { optimizationRepository } from './knowledge/optimization-repository';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const SKILL_DIR = process.env.SKILL_DIR || './skills';

let skillRegistry: SkillRegistry;

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

    // 7. Initialize Critic Agent
    console.log('🔍 Initializing Critic Agent...');
    const criticAgent = new CriticAgent(llmClient);
    await criticAgent.initialize();
    console.log('✅ Critic Agent initialized\n');

    // 8. Setup task completion listener for Critic review
    taskQueue.on('task-completed', async (data) => {
      try {
        const task = taskQueue.getTask(data.taskId);
        if (task) {
          // 异步审查任务
          setTimeout(async () => {
            try {
              const analysis = await criticAgent.reviewTask(task);
              
              // 保存分析结果到任务
              task.criticAnalysis = analysis;
              
              // 生成优化建议
              for (const solution of analysis.solutions) {
                optimizationRepository.createSuggestion({
                  description: solution.description,
                  type: task.skillName ? 'skill' : 'agent',
                  priority: solution.priority as any,
                  implementationSteps: solution.implementationSteps,
                  relatedSkills: task.skillName ? [task.skillName] : undefined,
                  relatedAgents: task.skillName ? ['sub'] : ['main'],
                  severity: analysis.issues.find(issue => issue.severity === 'high') ? 'high' : 'medium',
                  impact: `Task ${task.id} ${task.status} with ${analysis.issues.length} issues`
                });
              }
              
              // 记录审查日志
              await logManager.writeAuditLog({
                type: 'critic_review',
                taskId: task.id,
                skillName: task.skillName,
                issues: analysis.issues.length,
                solutions: analysis.solutions.length,
                confidence: analysis.confidence
              });
            } catch (error) {
              console.error('❌ Critic review failed:', error);
            }
          }, 0);
        }
      } catch (error) {
        console.error('❌ Task completion listener error:', error);
      }
    });

    // 9. Setup daily report generation
    console.log('📅 Setting up daily report generation...');
    setInterval(async () => {
      try {
        const now = new Date();
        if (now.getHours() === 23 && now.getMinutes() === 0) { // 每天23:00生成报告
          const tasks = taskQueue.getAllTasks();
          const completedTasks = tasks.filter(task => 
            task.status === 'completed' || task.status === 'failed'
          );
          
          if (completedTasks.length > 0) {
            const analyses = await criticAgent.reviewTasks(completedTasks);
            await reportGenerator.generateDailyCriticReport(now, analyses);
            console.log('📊 Daily critic report generated');
          }
        }
      } catch (error) {
        console.error('❌ Daily report generation failed:', error);
      }
    }, 60000); // 每分钟检查一次
    console.log('✅ Daily report generation setup\n');

    // 10. Create and start API Server
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
      console.log(`\n🔍 Critic Agent:`);
      console.log(`   Enabled: ✅`);
      console.log(`   Daily reports: ✅`);
      console.log(`   Optimization suggestions: ✅`);
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

process.on('SIGTERM', () => {
  skillRegistry.stopWatch();
  process.exit(0);
});

bootstrap();
