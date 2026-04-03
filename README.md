# Multi-Agent System

TypeScript-based multi-agent system with MainAgent orchestration and SubAgent skill execution.

## Architecture

- **MainAgent**: Planning-only orchestration (analyzes requirements, creates plans, dispatches to TaskQueue)
- **SubAgent**: Skill execution engine
- **Skill Registry**: Filesystem scanning with progressive disclosure
- **Task Queue**: DAG-based dependency management with concurrency control
- **LLM Client**: OpenRouter (Qwen3.6) + Vision (GLM-4V) integration
- **AutoCompactService**: 4-layer context compression (MICRO → AUTO → SESSION → REACTIVE)
- **DynamicContextBuilder**: Dynamic context injection (CLAUDE.md + Git + Memory)
- **Tool Interface**: Abstract tool layer with concurrency safety checks

## Quick Start

```bash
# Install dependencies
bun install

# Set API key
export ZHIPU_API_KEY=your-api-key-here

# Start server
bun run src/index.ts

# Open test page
open http://localhost:3000/test.html
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /health | Health check |
| GET | /skills | List all skills |
| POST | /tasks | Submit new task |
| GET | /tasks/:id | Get task status |
| GET | /tasks/:id/result | Get task result |
| DELETE | /tasks/:id | Cancel task |

See [API.md](API.md) for detailed documentation.

## Project Structure

```
src/
├── agents/
│   ├── main-agent.ts       # MainAgent planner (planning-only)
│   └── sub-agent.ts        # SubAgent executor
├── api/
│   └── index.ts            # HTTP API service
├── context/
│   ├── claude-md-loader.ts # CLAUDE.md loader (5-level hierarchy)
│   └── dynamic-context.ts  # Dynamic context builder
├── llm/
│   └── index.ts            # OpenRouter + Vision client
├── memory/
│   ├── auto-compact.ts     # 4-layer context compression
│   ├── memory-service.ts  # Memory management
│   └── conversation-memory.ts
├── skill-registry/
│   └── index.ts            # Skill discovery
├── task-queue/
│   └── index.ts            # Task scheduling
├── tools/
│   ├── base-tool.ts        # Tool abstract base class
│   ├── interfaces.ts      # Tool interface definitions
│   └── file-read-tool.ts  # Example tool implementation
├── types/
│   └── index.ts            # Type definitions
└── index.ts                # Server entry point

skills/
├── ees-qa/                 # EES expense system QA skill
├── geam-qa/               # GEAM image system QA skill
└── time-management-qa/    # Time management platform QA skill
```

## Configuration

Environment variables:
- `ZHIPU_API_KEY` - GLM API key (required)
- `PORT` - Server port (default: 3000)
- `SKILL_DIR` - Skills directory (default: ./skills)

## System Limits

- Max concurrent tasks: 5
- Task queue size: 100
- Task timeout: 30s
- LLM timeout: 60s
- Max replan attempts: 3

## License

MIT
