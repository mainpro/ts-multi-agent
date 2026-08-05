// __tests__/helpers/mock-profile-service.ts
//
// Test-only middleware that injects a synthetic UserProfile onto `req.profile`,
// simulating what the real `UserProfileService.loadProfile()` does at runtime.
// Intentionally NOT in `src/` because production code uses `UserProfileService`
// directly — see `src/api/index.ts`.
//
// NOTE: The mock adds future fields (`role`, `permissions`, `history`,
// `preferences`) that the current `UserProfile` type doesn't yet declare.
// Task 6 (UserProfile 字段扩展) will add them. Until then, we cast to `any`
// to keep this helper usable.
import type { RequestHandler } from 'express';

export function mockUserProfileService(): RequestHandler {
  return (req: any, res: any, next: any) => {
    const userId = req.body?.userId ?? 'u-1';
    req.profile = {
      userId,
      department: '财务部',
      commonSystems: [],
      tags: [],
      conversationCount: 0,
      lastActiveAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // Future fields (Task 6):
      role: 'employee',
      permissions: [],
      history: [],
      preferences: [],
    };
    next();
  };
}