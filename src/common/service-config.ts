import fs from 'fs';
import path from 'path';

import MANAGED_PATHS from './managed-paths';
import SUPPORTED_LANGUAGES from './supported-languages';
import { SemvarValidator } from './validation-utils';

export default class ServiceConfig {
  static _require(path: string) {
    return require(path);
  }

  static parsePathFromDependencyIdentifier(
    dependency_identifier: string,
    path_prefix?: string,
  ) {
    if (dependency_identifier.indexOf('file:') === 0) {
      return path_prefix ?
        path.join(path_prefix, dependency_identifier.slice(5)) :
        path.resolve(dependency_identifier.slice(5));
    }

    throw new UnsupportedDependencyIdentifierError(dependency_identifier);
  }

  static loadJSONFromPath(filepath: string): any {
    const config_path = path.join(filepath, MANAGED_PATHS.ARCHITECT_JSON);
    if (!fs.existsSync(config_path)) {
      throw new MissingConfigFileError(filepath);
    }
    return ServiceConfig._require(config_path);
  }

  static loadFromPath(filepath: string): ServiceConfig {
    const config_json = ServiceConfig.loadJSONFromPath(filepath);
    return ServiceConfig.create(config_json);
  }

  static writeToPath(filepath: string, config_json: object) {
    const config_path = path.join(filepath, MANAGED_PATHS.ARCHITECT_JSON);
    fs.writeFileSync(config_path, JSON.stringify(config_json, null, 2));
  }

  static create(configJSON: any) {
    return (new ServiceConfig())
      .setName(configJSON.name)
      .setVersion(configJSON.version)
      .setDescription(configJSON.description)
      .setKeywords(configJSON.keywords)
      .setAuthor(configJSON.author)
      .setLicense(configJSON.license)
      .setDependencies(configJSON.dependencies)
      .setProto(configJSON.proto)
      .setMainFile(configJSON.main)
      .setLanguage(configJSON.language);
  }

  static convertServiceNameToFolderName(service_name: string): string {
    return service_name.replace(/-/g, '_');
  }

  name: string;
  version: string;
  description: string;
  keywords: string[];
  author: string;
  license: string;
  dependencies: { [s: string]: string };
  proto?: string;
  main: string;
  language: SUPPORTED_LANGUAGES;

  constructor() {
    this.name = '';
    this.version = '0.1.0';
    this.description = '';
    this.keywords = [];
    this.author = '';
    this.license = 'ISC';
    this.dependencies = {};
    this.proto = undefined;
    this.main = 'index.js';
    this.language = SUPPORTED_LANGUAGES.NODE;
  }

  get full_name() {
    return `${this.name}:${this.version}`;
  }

  getNormalizedName() {
    return ServiceConfig.convertServiceNameToFolderName(this.name).replace(/\//g, '__');
  }

  getProtoName() {
    return this.proto ?
      this.proto.slice(0, this.proto.lastIndexOf('.')) :
      undefined;
  }

  setName(name: string) {
    this.name = name;
    return this;
  }

  setVersion(version: string) {
    const validator = new SemvarValidator();
    if (validator.test(version)) {
      this.version = version;
    }
    return this;
  }

  setDescription(description: string) {
    this.description = description;
    return this;
  }

  setKeywords(keywords: string | string[]) {
    if (typeof keywords === 'string') {
      keywords = keywords.split(',');
    }
    this.keywords = keywords;
    return this;
  }

  setAuthor(author: string) {
    this.author = author;
    return this;
  }

  setLicense(license: string) {
    this.license = license;
    return this;
  }

  setDependencies(dependencies: { [s: string]: string }) {
    this.dependencies = dependencies;
    return this;
  }

  setProto(protopath: string) {
    this.proto = protopath;
    return this;
  }

  setMainFile(main_file: string) {
    this.main = main_file;
    return this;
  }

  setLanguage(language: SUPPORTED_LANGUAGES) {
    this.language = language;
    return this;
  }

  // Indicates whether or not this configuration exposes a new
  // architect service that can be called as a dependency or if
  // its simply a script to be called once.
  isScript() {
    return !this.proto;
  }
}

export class MissingConfigFileError extends Error {
  name: string;
  message: string;

  constructor(filepath: string) {
    super();
    this.name = 'missing_config_file';
    this.message = `No config file found at ${filepath}`;
  }
}

export class UnsupportedDependencyIdentifierError extends TypeError {
  name: string;
  message: string;

  constructor(identifier: string) {
    super();
    this.name = 'unsupported_dependency_identifier';
    this.message = `Unsupported dependency identifier format: ${identifier}`;
  }
}
