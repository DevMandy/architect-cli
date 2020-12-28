import { IsBooleanString, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ValidatableConfig } from '../base-spec';

export class VolumeSpecV1 extends ValidatableConfig {
  @IsOptional({ always: true })
  @IsString({ always: true })
  mount_path?: string;

  @IsOptional({ groups: ['developer', 'operator'] })
  @IsNotEmpty({
    groups: ['debug'],
    message: 'Debug volumes require a host path to mount the volume to',
  })
  @IsString({ always: true })
  host_path?: string;

  @IsOptional({ always: true })
  @IsString({ always: true })
  description?: string;

  @IsOptional({ always: true })
  @IsBooleanString({ always: true })
  readonly?: string;
}
