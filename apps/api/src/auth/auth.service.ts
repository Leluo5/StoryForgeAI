import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Author } from '@storyforge/contracts';
import { DataSource, IsNull, MoreThan, Repository } from 'typeorm';
import { env } from '../config/env';
import { AuthorEntity } from '../database/author.entity';
import { NotificationEntity } from '../database/notification.entity';
import { SessionEntity } from '../database/session.entity';
import { PasswordService } from './password.service';

export interface LoginResult {
  sessionToken: string;
  csrfToken: string;
  author: Author;
}

/** 登录或自动注册结果：created 标记本次是否为自动注册的新账号 */
export type LoginOrRegisterResult = LoginResult & { created: boolean };

/** Postgres 唯一约束冲突错误码（authors.email 唯一索引） */
const UNIQUE_VIOLATION = '23505';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(AuthorEntity) private readonly authors: Repository<AuthorEntity>,
    @InjectRepository(SessionEntity) private readonly sessions: Repository<SessionEntity>,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @InjectRepository(NotificationEntity) private readonly notifications: Repository<NotificationEntity>,
    private readonly dataSource?: DataSource
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

    return this.createSession(author);
  }

  /**
   * 登录或自动注册（需求：未注册账号自动创建并登录）。
   *
   * - 账号已存在：走原 login 逻辑，返回 created=false（保留原登录流程，不影响已注册账号）。
   * - 账号不存在：事务内创建作者 + 写入通知留存（账号/密码），随后创建会话，返回 created=true。
   * - 并发重复创建：捕获唯一约束冲突（23505）回退为普通登录，避免数据不一致 / 重复创建。
   */
  async loginOrRegister(email: string, password: string): Promise<LoginOrRegisterResult> {
    const normalizedEmail = email.trim().toLowerCase();

    const existing = await this.authors.findOne({ where: { email: normalizedEmail } });
    if (existing) {
      // 已注册账号：走原登录流程，密码校验由 login 内部完成
      return { ...(await this.login(normalizedEmail, password)), created: false };
    }

    const passwordHash = await this.passwords.hash(password);
    try {
      const author = await this.createAuthorWithNotification(normalizedEmail, passwordHash, password);
      return { ...(await this.createSession(author)), created: true };
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        // 并发下另一请求已创建该账号：回退为普通登录，避免重复创建
        return { ...(await this.login(normalizedEmail, password)), created: false };
      }
      throw error;
    }
  }

  private async createAuthorWithNotification(
    email: string,
    passwordHash: string,
    rawPassword: string
  ): Promise<AuthorEntity> {
    const displayName = this.displayNameFromEmail(email);
    if (this.dataSource) {
      return this.dataSource.transaction(async (manager) => {
        const repo = manager.getRepository(AuthorEntity);
        const saved = await repo.save(repo.create({ email, display_name: displayName, password_hash: passwordHash }));
        await this.recordRegistrationNotice(manager.getRepository(NotificationEntity), saved.id, email, rawPassword);
        return saved;
      });
    }
    // 无 DataSource（单测环境）：直接保存 + 记录通知
    const saved = await this.authors.save(this.authors.create({ email, display_name: displayName, password_hash: passwordHash }));
    await this.recordRegistrationNotice(this.notifications, saved.id, email, rawPassword);
    return saved;
  }

  private async recordRegistrationNotice(
    repository: Repository<NotificationEntity>,
    authorId: string,
    email: string,
    rawPassword: string
  ): Promise<void> {
    await repository.save(repository.create({
      recipient_id: authorId,
      type: 'system',
      linked_object: null,
      content: `自动注册成功：账号 ${email}，初始密码已按登录输入留存。请妥善保管。`,
      read_at: null
    }));
  }

  private displayNameFromEmail(email: string): string {
    const prefix = email.split('@')[0] ?? 'author';
    return (prefix || 'author').slice(0, 80);
  }

  private isUniqueViolation(error: unknown): boolean {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      return (error as { code?: string }).code === UNIQUE_VIOLATION;
    }
    return false;
  }

  private async createSession(author: AuthorEntity): Promise<LoginResult> {
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
