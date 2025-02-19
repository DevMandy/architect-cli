import fs from 'fs-extra';
import path from 'path';
import { Dictionary } from '../dependency-manager/src/utils/dictionary';
import LocalPaths from '../paths';

export default class AppConfig {
  private config_dir: string;
  log_level: 'info' | 'debug' | 'test';
  registry_host: string;
  api_host: string;
  app_host: string;
  oauth_host: string;
  oauth_client_id: string;
  account: string;

  constructor(config_dir: string, partial?: Partial<AppConfig>) {
    this.config_dir = config_dir;

    if (partial?.registry_host) {
      partial.registry_host = partial.registry_host.replace('http://', '').replace('https://', '');
    }

    // Set defaults
    this.log_level = 'info';
    this.registry_host = 'registry.architect.io';
    this.api_host = 'https://api.architect.io';
    this.app_host = 'https://cloud.architect.io';
    this.oauth_host = 'https://auth.architect.io';
    this.oauth_client_id = '079Kw3UOB5d2P6yZlyczP9jMNNq8ixds';
    this.account = '';

    // Override defaults with input values
    Object.assign(this, partial);

    // Use new cloud address
    if (this.app_host.includes('app.architect.io')) {
      this.app_host = 'https://cloud.architect.io';
    }
  }

  defaultAccount(): string | null {
    return this.account === '' ? null : this.account;
  }

  getConfigDir(): string {
    return this.config_dir;
  }

  save(): void {
    const config_file = path.join(this.config_dir, LocalPaths.CLI_CONFIG_FILENAME);
    fs.writeJSONSync(config_file, this, { spaces: 2 });
  }

  toJSON(): Dictionary<string> {
    return {
      log_level: this.log_level,
      registry_host: this.registry_host,
      api_host: this.api_host,
      app_host: this.app_host,
      oauth_host: this.oauth_host,
      oauth_client_id: this.oauth_client_id,
      account: this.account,
    };
  }
}
