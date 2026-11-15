import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Author } from '@storyforge/contracts';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { env } from '../config/env';
import { AuthorEntity } from '../database/author.entity';
import { SessionEntity } from '../database/session.entity';
import { PasswordService } from './password.service';

export interface LoginResult {
  sessionToken: string;
  csrfToken: string;
  author: Author;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(AuthorEntity) private readonly authors: Repository<AuthorEntity>,
    @InjectRepository(SessionEntity) private readonly sessions: Repository<SessionEntity>,
    @Inject(PasswordService) private readonly passwords: PasswordService
  ) {}

  createRawToken(): string {
    return randomBytes(32).toString('hex');
  }

  hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  async login(email: string, password: string): Promise<LoginResult> {
    const author = await this.authors.findOne({ where: { email: email.trim().toLowerCase() } });
    if (!author || !await this.passwords.verify(author.password_hash, password)) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const sessionToken = this.createRawToken();
    const csrfToken = this.createRawToken();
    await this.sessions.save(this.sessions.create({
      author_id: author.id,
      token_hash: this.hashToken(sessionToken),
      expires_at: new Date(Date.now() + env.SESSION_TTL_SECONDS * 1000),
      revoked_at: null
    }));
    return { sessionToken, csrfToken, author: this.toAuthor(author) };
  }

  async validate(raw: string | undefined): Promise<Author | null> {
    if (!raw) return null;
    const session = await this.sessions.findOne({
      where: {
        token_hash: this.hashToken(raw),
        revoked_at: IsNull(),
        expires_at: MoreThan(new Date())
      },
      relations: { author: true }
    });
    return session ? this.toAuthor(session.author) : null;
  }

  async logout(raw: string | undefined): Promise<void> {
    if (!raw) return;
    await this.sessions.update(
      { token_hash: this.hashToken(raw) },
      { revoked_at: new Date() }
    );
  }

  private toAuthor(author: AuthorEntity): Author {
    return { id: author.id, email: String(author.email), display_name: author.display_name };
  }
}
