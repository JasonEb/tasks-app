import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtStrategy } from './jwt.strategy.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { OptionalJwtAuthGuard } from './guards/optional-jwt-auth.guard.js';

@Module({
    imports: [
        PassportModule,
        JwtModule.register({ secret: process.env.JWT_SECRET, signOptions: { expiresIn: '1d' }}),
    ],
    controllers: [AuthController],
    providers: [AuthService], JwtStrategy, JwtAuthGuard, OptionalJwtAuthGuard],
    exports: [JwtAuthGuard, OptionalJwtAuthGuard]
})
export class AuthModule {}