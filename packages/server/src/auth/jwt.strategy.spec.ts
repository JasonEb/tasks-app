import { JwtStrategy, extractTokenFromCookie } from './jwt.strategy.js';

describe('JwtStrategy', () => {
    beforeAll(() => {
        process.env.JWT_SECRET = 'test-secret';
    });

    it ('extracts the token from the cookie', () => {
        expect(extractTokenFromCookie({ cookies: { access_token: 'abc' } } as any)).toBe('abc');
        expect(extractTokenFromCookie({ cookies: {} } as any )).toBeNull();
        expect(extractTokenFromCookie({ cookies: undefined } as any )).toBeNull();
    });

    it ('maps the JWT payload to req.user shape', async () => {
        const strategy = new JwtStrategy();
        const result = await strategy.validate( { sub: '123', email: 'a@b.com'});
        expect(result).toEqual({ id: '123', email: 'a@b.com'})
    });
})