import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('volumes')
export class VolumeEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) work_id!: string;
  @Column({ type: 'varchar', length: 120 }) title!: string;
  @Column({ type: 'integer' }) position!: number;
}
