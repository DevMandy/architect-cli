
/* eslint-disable no-empty */
import deepmerge from 'deepmerge';
import yaml from 'js-yaml';
import path from 'path';
import { flattenValidationErrorsWithLineNumbers, ValidationErrors } from '../utils/errors';
import { tryReadFromPaths } from '../utils/files';
import NULL_TYPE from '../utils/yaml/null';
import { ComponentConfig } from './config/component-config';
import { validateOrRejectConfig } from './config/component-validator';
import { validateOrRejectSpec } from './spec-validator';
import { ComponentSpec } from './spec/component-spec';
import { transformComponentSpec } from './spec/transform/component-transform';

class MissingConfigFileError extends Error {
  constructor(filepath: string) {
    super();
    this.name = 'missing_config_file';
    this.message = `No component config file found at ${filepath}`;
  }
}

export type ParsedYaml = object | string | number | null | undefined;

// TODO:269: remove exports from methods that don't need to be public
export const specPaths = (input: string) => {
  return [
    input,
    path.join(input, 'architect.yml'),
    path.join(input, 'architect.yaml'),
  ];
};

export const loadSpecFromPathOrReject = (config_path: string): { file_path: string; file_contents: string } => {
  try {
    const try_files = specPaths(config_path);
    return tryReadFromPaths(try_files);
  } catch (err) {
    throw new MissingConfigFileError(config_path);
  }
};

export const parseSourceYml = (source_yml: string): ParsedYaml => {
  return yaml.load(source_yml, { schema: yaml.JSON_SCHEMA.extend({ implicit: [NULL_TYPE] }) });
};

export const buildConfigFromYml = (source_yml: string, tag: string): ComponentConfig => {
  const parsed_yml = parseSourceYml(source_yml);

  const spec = validateOrRejectSpec(parsed_yml);
  const config = transformComponentSpec(spec, source_yml, tag);
  validateOrRejectConfig(config);
  return config;
};

export const deepMergeSpecIntoComponent = (src: Partial<ComponentSpec>, target: ComponentConfig): ComponentConfig => {
  const parsed_yml = parseSourceYml(target.source_yml);
  const spec = validateOrRejectSpec(parsed_yml);
  const merged_yml = deepmerge(src, spec);
  const new_spec = validateOrRejectSpec(merged_yml);
  const merged_string = yaml.dump(merged_yml);

  return transformComponentSpec(new_spec, merged_string, target.tag);
};

export const buildConfigFromPath = (spec_path: string, tag: string): { component_config: ComponentConfig; source_path: string } => {
  const { file_path: source_path, file_contents: source_yml } = loadSpecFromPathOrReject(spec_path);

  try {
    return {
      component_config: buildConfigFromYml(source_yml, tag),
      source_path,
    };
  } catch (err) {
    throw new ValidationErrors(source_path, flattenValidationErrorsWithLineNumbers(err, source_yml));
  }
};
