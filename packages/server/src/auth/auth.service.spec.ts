import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { JwtService } from '@nestjs/jwt';

describe('AuthService', () => {
    it('rejects login with wrong password', async () => {
        const correctPasswordHash = await bcrypt.hash('correct', 10);

        const existingUser = {
            id: '1',
            email: 'a@b.com',
            passwordHash: correctPasswordHash,
        };

        const prismaMock = {
            user: {
                findUnique: async () => existingUser,
            },
        };

        const jwtMock = {
            signAsync: async () => 'token',
        };

        const module = await Test.createTestingModule({
            providers: [
                AuthService,
                { provide: PrismaService, useValue: prismaMock },
                { provide: JwtService, useValue: jwtMock },
            ],
        }).compile();

        const service = module.get(AuthService);

        await expect(
            service.login({ email: 'a@b.com', password: 'wrong' }),
        ).rejects.toThrow();
    });
});
