import { Injectable, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
    handleRequest<TUser = any>(err: unknown, user: unknown): TUser {
        return (user ?? null) as TUser; //never throws; req.user is null instead of 401
    }

    canActivate(context: ExecutionContext) {
        return super.canActivate(context) as Promise<boolean>;
    }
}