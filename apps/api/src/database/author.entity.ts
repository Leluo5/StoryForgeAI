import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('authors')
export class AuthorEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'citext', unique: true })
  email!: string;

  @Column({ type: 'varchar', length: 80 })
  display_name!: string;

  @Column({ type: 'text' })
  password_hash!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
