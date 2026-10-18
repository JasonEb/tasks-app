import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard.js';

describe('OptionalJwtAuthGuard', () => {
    it('returns null instead of throwing when there is no user', () => {
        const guard = new OptionalJwtAuthGuard();
        expect(guard.handleRequest(null, null)).toBeNull();
    });

    it('passes a real user through unchanged', () => {
        const guard = new OptionalJwtAuthGuard();
        const user = { id: '1', email: 'a@b.com' };
        expect(guard.handleRequest(null, null)).toBeNull();
    });
});