# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - TBD

> Claude Code-Aligned Refactoring - Tool System Overhaul

### 🚀 Planned Breaking Changes

This version aligns the architecture with Claude Code's tool system design while keeping unique multi-agent features.

#### Tool System Redesign (Aligned with Claude Code)

**New Tool Implementations:**
- **BashTool**: Execute shell commands (scripts in skills)
- **GlobTool**: Search files by pattern
- **GrepTool**: Search file contents
- **EditTool**: Edit file contents
- **WriteTool**: Write/create files
- **ReadTool**: Read files (enhanced from FileReadTool)

**Tool Interface Updates:**
- Standardized `name`, `description`, `inputSchema` for each tool
- Unified `execute(context)` method signature
- Tool result standardization

#### Skill System Refactoring

- Skills now expose allowed tools list
- Script execution via BashTool integration
- Reference files accessible via ReadTool

#### Architecture Changes

**To be implemented:**
- ToolRegistry for dynamic tool registration
- MCP client preparation for external integrations
- Working directory tracking
- Tool result streaming support

---

## [2.0.0] - 2026-04-03

> Claude Code Architecture Upgrade - Major Architecture Refactoring

### 🚀 Breaking Changes

- **MainAgent Role Separation**: MainAgent now performs planning-only operations. All execution logic has been moved to SubAgent.
- **Tool Interface**: Introduced new abstract Tool layer. Existing skills remain compatible via progressive migration.

### ✨ New Features

#### Context Compression (P0 - Critical)
- **AutoCompactService**: Four-layer context compression system
  - `MICRO`: Zero-cost compaction (clears tool results >5min old)
  - `AUTO`: LLM summarization at 167K token threshold (83.5% context window)
  - `SESSION`: Session-level compaction
  - `REACTIVE`: Reactive compaction based on context pressure
- **Token Tracking**: Real-time token estimation (characters/4, ~85% accuracy)
- **Circuit Breaker**: Automatic stop after 3 consecutive compression failures

#### Dynamic Context Builder (P1)
- **User Memory**: User profile and conversation history integration
- **Context Injection**: Automatically injected into planning prompts
- **Note**: CLAUDE.md and Git features removed (not needed for multi-agent systems)

#### Tool Interface (P1)
- **BaseTool**: Abstract base class with conservative defaults
  - `isConcurrencySafe()`: Returns `false` by default
  - `isReadOnly()`: Returns `false` by default
- **Tool Interface**: Standardized contract for all tools
  - `execute(input, context)`: Core execution method
  - `isConcurrencySafe(input)`: Concurrency safety check
  - `isReadOnly()`: Read-only identification
- **FileReadTool**: Example tool implementation (read-only, concurrency-safe)

#### MainAgent Refactoring (P1)
- Removed `executeSingleSkill()` method (182 lines removed)
- Integrated DynamicContextBuilder for context injection
- Removed VisionLLMClient dependency (moved to SubAgent)
- Planning-only architecture enforced

### 🧪 Testing

- **Unit Tests**: 91 tests passing (new modules: 100% coverage)
- **Integration Tests**: 11 tests for realistic scenarios
- **Test Infrastructure**: Organized under `tests/` directory
  - `tests/helpers/`: Message factory, test utilities
  - `tests/mocks/`: LLM mock, etc.
  - `tests/integration/`: End-to-end scenarios

### 📚 Documentation

- **README.md**: Updated architecture section with new components
  - Added project structure for new modules
  - Updated technology stack (OpenRouter + Vision)
  - Added skill descriptions (ees-qa, geam-qa, time-management-qa)

### 🎯 Performance

- Token estimation: <5% error rate
- Compression effect: >50% token reduction
- Response time: P95 <3s
- Memory: Stable across test runs

### 📁 New Files Added

```
src/
├── context/
│   ├── claude-md-loader.ts      # CLAUDE.md 5-level hierarchy loader
│   └── dynamic-context.ts       # Dynamic context builder
├── memory/
│   └── auto-compact.ts          # 4-layer compression service
└── tools/
    ├── base-tool.ts            # Abstract base class
    ├── interfaces.ts            # Tool interface definitions
    └── file-read-tool.ts       # Example tool implementation

tests/
├── helpers/
│   ├── message-factory.ts
│   └── ...
├── mocks/
│   └── llm-mock.ts
└── integration/
    ├── auto-compact-integration.test.ts
    └── dynamic-context-integration.test.ts
```

### 🔧 Configuration Changes

- Context window threshold: 167K tokens (configurable)
- Micro-compact threshold: 5 minutes
- Circuit breaker: 3 max consecutive failures

---

## [1.0.1] - 2026-03-18

### Fixed
- Fixed Promise.race timeout logic in TaskQueue.executeTask()
- Fixed task filtering to allow tasks without skillName
- Fixed timeout race condition by unifying timeout handling

### Added
- Added result size limit (1MB) to prevent memory issues
- Added performance metrics collection (tasksCompleted, tasksFailed, tasksTimedOut, averageExecutionTime)
- Added execution time logging for better observability

### Changed
- Improved error handling in task execution
- Enhanced logging with execution time tracking
