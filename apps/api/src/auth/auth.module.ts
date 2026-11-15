import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthorEntity } from '../database/author.entity';
import { SessionEntity } from '../database/session.entity';
import { PasswordService } from './password.service';

@Module({
  imports: [TypeOrmModule.forFeature([AuthorEntity, SessionEntity])],
  providers: [PasswordService],
  exports: [PasswordService]
})
export class AuthModule {}
