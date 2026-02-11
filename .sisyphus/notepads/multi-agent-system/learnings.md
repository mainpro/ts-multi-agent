# TaskQueue Implementation Learnings

## Date: 2026-02-11

### Implementation Patterns

1. **Map + Set Architecture**
   - `Map<string, Task>` for O(1) task lookup
   - `Set<string>` for tracking running task IDs
   - Enables fast concurrency checks: `running.size`

2. **DFS Cycle Detection Algorithm**
   - For each dependency of new task, check if new task is reachable
   - Use visited set to avoid infinite loops in traversal
   - Time complexity: O(V + E) where V = tasks, E = dependencies

3. **State Machine Implementation**
   - pending → running → completed/failed
   - State transitions happen in specific methods:
     - `executeTask()`: pending → running
     - `completeTask()`: running → completed
     - `failTask()`: any → failed

4. **Timeout Management Pattern**
   - Store timeout handles in Map for cleanup
   - Always call `clearTimeout()` in finally block
   - Use `Promise.race()` with never-resolving promise for timeout

5. **Concurrency Control**
   - Check `running.size >= MAX_CONCURRENT_SUBAGENTS` before starting
   - Use `setImmediate()` to avoid stack overflow in recursion

### Gotchas

- Must update both `dependencies` (on task) and `dependents` (on dependency)
- When task fails, must cascade fail to all dependents
- When clearing queue, must clear all pending timeouts to prevent memory leaks
- `isProcessing` flag prevents concurrent queue processing

### TypeScript Specifics

- Used `ReturnType<typeof setTimeout>` for timeout handle type
- Exported class + default export for flexibility
- Used `unknown` for task result type (to be defined by consumer)
