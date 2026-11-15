import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthorEntity } from '../database/author.entity';
import { SessionEntity } from '../database/session.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CsrfGuard } from './csrf.guard';
import { PasswordService } from './password.service';
import { SessionGuard } from './session.guard';

@Module({
  imports: [TypeOrmModule.forFeature([AuthorEntity, SessionEntity])],
  controllers: [AuthController],
  providers: [AuthService, CsrfGuard, PasswordService, SessionGuard],
  exports: [AuthService, CsrfGuard, PasswordService, SessionGuard]
})
export class AuthModule {}
