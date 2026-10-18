import { TaskAccessGuard } from './task-access.guard.js';
import { ExecutionContext } from '@nestjs/common';

function makeContext(task: any, userId?: string) {
    const req = { params: { id: 'task-1' }, user: userId ? { id: userId } : null };
    return {
        switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
}

describe('TaskAccessGuard', () => {
    const owner = 'owner-1';
    const stranger = 'stranger-1';

    it.each([
        ['public', owner, true],
        ['public', stranger, true],
        ['public', undefined, true],
        ['private', owner, true],
        ['private', stranger, false],
        ['private', undefined, false],       
    ])('visibility=%s, requester%s -> %s', async (visibility, requesterId, expected) => {
        const prismaMock = { task: { findUnique: async () => ({ id: 'task-1', ownerId: owner, visibility})}};
        const guard = new TaskAccessGuard(prismaMock as any);
        const result = await guard.canActivate(makeContext(null, requesterId));
        expect(result).toBe(expected);
    })
});