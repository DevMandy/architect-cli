import { Dictionary } from '../../utils/dictionary';

export interface DeployModuleConfig {
  path: string;
  inputs: Dictionary<string | null>;
}

export interface DeployConfig {
  strategy: string;
  modules: Dictionary<DeployModuleConfig>;
}

export interface VolumeConfig {
  mount_path?: string;
  host_path?: string;
  key?: string;
  description?: string;
  readonly?: boolean | string;
}

export interface BuildConfig {
  context?: string;
  args?: Dictionary<string>;
  dockerfile?: string;
}

export interface ResourceConfig {
  name: string;
  tag: string;
  description?: string;
  image?: string;
  command?: string[];
  entrypoint?: string[];
  language?: string;
  debug?: ResourceConfig;
  environment: Dictionary<string | null>;
  volumes: Dictionary<VolumeConfig>;
  build: BuildConfig;
  cpu?: number | string;
  memory?: string;
  deploy?: DeployConfig;
  depends_on: string[];
  labels: Map<string, string>;
}
