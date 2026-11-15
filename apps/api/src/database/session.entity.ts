import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { AuthorEntity } from './author.entity';

@Entity('sessions')
export class SessionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  author_id!: string;

  @ManyToOne(() => AuthorEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'author_id' })
  author!: AuthorEntity;

  @Index({ unique: true })
  @Column({ type: 'char', length: 64 })
  token_hash!: string;

  @Column({ type: 'timestamptz' })
  expires_at!: Date;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  revoked_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
