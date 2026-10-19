import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateTaskDto } from './dto/create-task.dto.js';

@Injectable()
export class TasksService {
    constructor(private readonly prisma: PrismaService) {}

    create(ownerId: string, dto: CreateTaskDto ) {
        return this.prisma.task.create( { data: { ...dto, ownerId }});
    }

    findAllVisibleTo(userId?: string) {
        return this.prisma.task.findMany({
            where: { OR: [{ visibility: 'public' }, ...(userId ? [{ ownerId: userId }] : [] )]}
        })
    }
}