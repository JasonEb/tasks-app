import { Test } from '@nestjs/testing';
import { TasksService } from './tasks.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

describe('TasksService', () => {
    it('includes the caller\'s own tasks alongside public ones when logged in', async () => {
        let capturedWhere: unknown;
        const prismaMock = {
            task: {
                findMany: async(args: {where: unknown }) => {
                    capturedWhere = args.where;
                    return [];
                },
            },
        };

        const module = await Test.createTestingModule({
            providers: [TasksService, { provide: PrismaService, useValue: prismaMock }],
        }).compile()

        const service = module.get(TasksService);
        await service.findAllVisibleTo('user-1');

        expect(capturedWhere).toEqual({
            OR: [{ visibility: 'public' }, { ownerId: 'user-1' }] });
        });
    })