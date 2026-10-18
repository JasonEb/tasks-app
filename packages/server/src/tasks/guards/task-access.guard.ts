import { CanActivate, ExecutionContext, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class TaskAccessGuard implements CanActivate {
    constructor(private readonly prisma: PrismaService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest();
        const task = await this.prisma.task.findUnique({ where: { id: req.params.id }});
        if (!task) throw new NotFoundException();

        req.task = task; // avoids a second query in the new handler
        return task.visibility === 'public' || task.ownerId === req.user?.id;
    }
}