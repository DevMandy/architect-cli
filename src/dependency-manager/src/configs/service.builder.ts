/* eslint-disable no-empty */
import { plainToClass, plainToClassFromExist } from 'class-transformer';
import fs from 'fs-extra';
import yaml from 'js-yaml';
import path from 'path';
import { ServiceConfig } from './service';
import { EnvironmentServiceSpecV1 } from './v1-spec/environment';
import { ServiceSpecV1 } from './v1-spec/service';

class MissingConfigFileError extends Error {
  constructor(filepath: string) {
    super();
    this.name = 'missing_config_file';
    this.message = `No config file found at ${filepath}`;
  }
}

export class ServiceConfigBuilder {
  static getConfigPaths(input: string) {
    return [
      input,
      path.join(input, 'architect.json'),
      path.join(input, 'architect.yml'),
      path.join(input, 'architect.yaml'),
    ];
  }

  static buildFromPath(input: string): ServiceConfig {
    const try_files = ServiceConfigBuilder.getConfigPaths(input);

    // Make sure the file exists
    let file_contents;
    for (const file of try_files) {
      try {
        const data = fs.lstatSync(file);
        if (data.isFile()) {
          file_contents = fs.readFileSync(file, 'utf-8');
          break;
        }
      } catch {
        continue;
      }
    }

    if (!file_contents) {
      throw new MissingConfigFileError(input);
    }

    // Try to parse as json
    try {
      const js_obj = JSON.parse(file_contents);
      return ServiceConfigBuilder.buildFromJSON(js_obj);
    } catch {}

    // Try to parse as yaml
    try {
      const js_obj = yaml.safeLoad(file_contents);
      return ServiceConfigBuilder.buildFromJSON(js_obj);
    } catch {}

    throw new Error('Invalid file format. Must be json or yaml.');
  }

  static buildFromJSON(obj: object): ServiceConfig {
    return plainToClass(ServiceSpecV1, obj);
  }

  static saveToPath(input: string, config: ServiceConfig) {
    const try_files = ServiceConfigBuilder.getConfigPaths(input);

    for (const file of try_files) {
      if (file.endsWith('.json')) {
        fs.writeJsonSync(file, config, { spaces: 2 });
        return;
      } else if (file.endsWith('.yml') || file.endsWith('.yaml')) {
        fs.writeFileSync(file, yaml.safeDump(config));
        return;
      }
    }

    throw new Error(`Cannot save config to invalid path: ${input}`);
  }

  static createServiceConfig() {
    return new ServiceSpecV1();
  }

  static createEnvironmentServiceConfig() {
    return new EnvironmentServiceSpecV1();
  }

  static merge(target: ServiceConfig, source: ServiceConfig) {
    return plainToClassFromExist(target, source);
  }
}
