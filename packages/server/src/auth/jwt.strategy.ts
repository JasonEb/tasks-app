import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import type { Request } from 'express';

export function extractTokenFromCookie(req: Request): string | null {
    return req.cookies?.['access_token'] ?? null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
    constructor() {
        const secretOrKey = process.env.JWT_SECRET;
        if (!secretOrKey) {
            throw new Error('JWT_SECRET is not set');
        }
        super({
            jwtFromRequest: extractTokenFromCookie,
            secretOrKey,
        });
    }

    async validate(payload: { sub: string; email: string }) {
        return { id: payload.sub, email: payload.email };
    }
}