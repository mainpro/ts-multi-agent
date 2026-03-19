# Changelog

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
