import { classToClass, plainToClassFromExist } from 'class-transformer';
import { BaseSpec } from '../utils/base-spec';

export interface VaultParameter {
  vault: string;
  key: string;
}

export interface DependencyParameter {
  dependency: string;
  value: string;
  interface?: string;
}

export interface DatastoreParameter {
  datastore: string;
  value: string;
}

export interface ValueFromParameter<T> {
  valueFrom: T;
}

export type ParameterValue = string | number | boolean | ValueFromParameter<DependencyParameter | VaultParameter | DatastoreParameter>;
export type ParameterValueV2 = string | number | undefined; //TODO:86: switch over to use this when we remove support for valueFrom syntax

export type EnvironmentVariable = string;

export interface ServiceParameter {
  description: string;
  default?: ParameterValue;
  required: boolean;
  build_arg?: boolean;
}

export interface ServiceDatastore {
  host?: string;
  port?: number;
  image?: string;
  parameters: {
    [key: string]: ServiceParameter;
  };
}

export interface ServiceInterfaceSpec {
  description?: string;
  host?: string;
  port?: number;
  subdomain?: string;
}

export interface ServiceLivenessProbe {
  success_threshold?: number;
  failure_threshold?: number;
  timeout?: string;
  path?: string;
  interval?: string;
  command?: string[];
  port?: number;
}

export interface VolumeSpec {
  mount_path?: string;
  host_path?: string;
  description?: string;
  readonly?: boolean;
}

export abstract class ServiceConfig extends BaseSpec {
  abstract __version: string;
  abstract getPath(): string | undefined;
  abstract getExtends(): string | undefined;
  abstract getRef(): string;
  abstract getName(): string;
  abstract getKeywords(): string[];
  abstract getAuthor(): string;
  abstract getLanguage(): string;
  abstract getImage(): string;
  abstract setImage(image: string): void;
  abstract getDigest(): string | undefined;
  abstract setDigest(digest: string): void;
  abstract getCommand(): string[];
  abstract getEntrypoint(): string[];
  abstract getDockerfile(): string | undefined;
  abstract getParameters(): { [s: string]: ServiceParameter };
  abstract getEnvironmentVariables(): { [s: string]: EnvironmentVariable };
  abstract setEnvironmentVariable(key: string, value: string): void;
  abstract getInterfaces(): { [s: string]: ServiceInterfaceSpec };
  abstract getDebugOptions(): ServiceConfig | undefined;
  abstract setDebugPath(debug_path: string): void;
  abstract getPlatforms(): { [s: string]: any };
  abstract getPort(): number | undefined;
  abstract getVolumes(): { [s: string]: VolumeSpec };
  abstract getReplicas(): number;
  abstract getLivenessProbe(): ServiceLivenessProbe | undefined;

  copy() {
    return classToClass(this);
  }

  merge(other_config: ServiceConfig): ServiceConfig {
    return plainToClassFromExist(this.copy(), other_config);
  }
}
