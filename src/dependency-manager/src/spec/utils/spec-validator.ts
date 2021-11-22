import Ajv, { ErrorObject, ValidateFunction } from "ajv";
import ajv_errors from "ajv-errors";
import addFormats from "ajv-formats";
import { plainToClass } from 'class-transformer';
import cron from 'cron-validate';
import leven from 'leven';
import { Dictionary } from '../../utils/dictionary';
import { ValidationError, ValidationErrors } from '../../utils/errors';
import { buildContextMap, replaceBrackets } from '../../utils/interpolation';
import { ComponentSpec } from '../component-spec';
import { ParsedYaml } from './component-builder';
import { findDefinition, getArchitectJSONSchema } from './json-schema';

export type AjvError = ErrorObject[] | null | undefined;

export const findPotentialMatch = (value: string, options: string[], max_distance = 15): string | undefined => {
  let potential_match;
  let shortest_distance = Infinity;
  const value_length = value.length;
  for (const option of [...options].sort()) {
    const option_length = option.length;
    // https://github.com/sindresorhus/leven/issues/14
    if (Math.abs(value_length - option_length) >= max_distance) {
      continue;
    }

    const distance = leven(value, option);
    if (distance < max_distance && distance <= shortest_distance) {
      potential_match = option;
      shortest_distance = distance;
    }
  }
  return potential_match;
};

function escapeRegex(string: string) {
  return string.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

export const addLineNumbers = (value: string, errors: ValidationError[]): void => {
  const rows = value.split('\n');
  const total_rows = rows.length;
  for (const error of errors) {
    const keys = error.path.split('.');
    let pattern = '(.*?)' + keys.map((key) => `${escapeRegex(key)}:`).join('(.*?)');

    const target_value = `${error.value}`.split('\n')[0];
    if (!error.invalid_key) {
      pattern += `(.*?)${escapeRegex(target_value)}`;
    }

    const exp = new RegExp(pattern, 's');
    const matches = exp.exec(value);
    if (matches) {
      const match = matches[0];
      const remaining_rows = value.replace(match, '').split('\n');
      const target_row = total_rows - remaining_rows.length;
      const end_row = rows[target_row];

      const end_length = (remaining_rows[0]?.length || 0);

      if (error.invalid_key) {
        error.start = {
          row: target_row + 1,
          column: (end_row.length - end_row.trimLeft().length) + 1,
        };
        error.end = {
          row: target_row + 1,
          column: end_row.length - end_length,
        };
      } else {
        error.start = {
          row: target_row + 1,
          column: (end_row.length - (target_value.length + (end_length ? end_length - 1 : 0))),
        };
        error.end = {
          row: target_row + 1,
          column: end_row.length - end_length,
        };
      }
    }
  }
};

export const mapAjvErrors = (parsed_yml: ParsedYaml, ajv_errors: AjvError): ValidationError[] => {
  if (!ajv_errors?.length) {
    return [];
  }

  // Expand ajv-errors errorMessage
  for (const ajv_error of ajv_errors.filter(e => e.keyword === 'errorMessage')) {
    for (const error of ajv_error.params.errors) {
      if (error.keyword === 'additionalProperties') {
        error.message = ajv_error.message;
        error.params.has_message = true;
        ajv_errors.push(error);
      }
    }
  }

  const ajv_error_map: Dictionary<ErrorObject> = {};
  for (const ajv_error of ajv_errors) {
    // Ignore noisy and redundant anyOf errors
    if (ajv_error.keyword === 'anyOf') {
      continue;
    }

    ajv_error.instancePath = ajv_error.instancePath.replace(/\//g, '.').replace('.', '');

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const additional_property: string | undefined = ajv_error.params?.additionalProperty;
    if (additional_property) {
      if (!ajv_error.params.has_message) {
        ajv_error.message = `Invalid key: ${additional_property}`;

        const definition = findDefinition(replaceBrackets(ajv_error.instancePath), getArchitectJSONSchema());
        if (definition) {
          const keys = Object.keys(definition.properties || {}).map((key) => ajv_error.instancePath ? `${ajv_error.instancePath}.${key}` : key);

          const potential_match = findPotentialMatch(`${ajv_error.instancePath}.${additional_property}`, keys);

          if (potential_match) {
            const match_keys = potential_match.split('.');
            ajv_error.message += ` - Did you mean ${match_keys[match_keys.length - 1]}?`;
          }
        }
      }

      ajv_error.instancePath += ajv_error.instancePath ? `.${additional_property}` : additional_property;
    }

    if (!ajv_error_map[ajv_error.instancePath]) {
      ajv_error_map[ajv_error.instancePath] = ajv_error;
    } else {
      ajv_error_map[ajv_error.instancePath].message += ` or ${ajv_error.message}`;
    }
  }

  // Filter error list to remove less specific errors
  const sorted_data_path_keys = Object.keys(ajv_error_map).sort(function (a, b) {
    return b.length - a.length;
  });
  const ignore_data_paths = new Set<string>();
  for (const data_path of sorted_data_path_keys) {
    const segments_list = data_path.split('.');
    const segments = segments_list.slice(0, segments_list.length - 1);
    let path = '';
    for (const segment of segments) {
      path += path ? `.${segment}` : segment;
      ignore_data_paths.add(path);
    }
  }

  const context_map = buildContextMap(parsed_yml);

  const errors: ValidationError[] = [];
  for (const [data_path, error] of Object.entries(ajv_error_map)) {
    if (ignore_data_paths.has(data_path)) {
      continue;
    }
    const normalized_path = replaceBrackets(data_path);
    let value = context_map[normalized_path?.startsWith('.') ? normalized_path.substr(1) : normalized_path];

    if (value instanceof Object && JSON.stringify(value).length > 1000) {
      value = '<truncated-object>';
    }

    errors.push(new ValidationError({
      component: parsed_yml instanceof Object ? (parsed_yml as any).name : '<unknown>',
      path: error.instancePath,
      message: error.message?.replace(/__arc__/g, '') || 'Unknown error',
      value: value === undefined ? '<unknown>' : value,
      invalid_key: error.keyword === 'additionalProperties',
    }));
  }

  return errors;
};

const cron_options = { preset: 'default', override: { useBlankDay: true } };

let _cached_validate: ValidateFunction;
export const validateSpec = (parsed_yml: ParsedYaml): ValidationError[] => {
  if (!_cached_validate) {
    // TODO:288 enable strict mode?
    const ajv = new Ajv({ allErrors: true, unicodeRegExp: false });
    addFormats(ajv);
    ajv.addFormat('cidrv4', /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)(?:\/(?:3[0-2]|[12]?[0-9]))?$/);
    ajv.addFormat('cron', (value: string): boolean => cron(value, cron_options).isValid());
    ajv.addKeyword('externalDocs');
    // https://github.com/ajv-validator/ajv-errors
    ajv_errors(ajv);
    _cached_validate = ajv.compile(getArchitectJSONSchema());
  }

  const valid = _cached_validate(parsed_yml);
  if (!valid) {
    return mapAjvErrors(parsed_yml, _cached_validate.errors);
  }
  return [];
};


export const validateServiceAndTaskKeys = (component: ComponentSpec): ValidationError[] => {
  const errors = [];

  // checks for duplicate keys across the two dictionaries
  const service_keys = Object.keys(component.services || {});
  const task_keys = Object.keys(component.tasks || {});
  const duplicates = service_keys.filter(s => task_keys.includes(s));

  if (duplicates.length) {
    const error = new ValidationError({
      component: component.name,
      path: 'services',
      message: 'services and tasks must not share the same keys',
      value: duplicates,
    });
    errors.push(error);
  }

  return errors;
};

export const isPartOfCircularReference = (search_name: string, depends_on_map: { [name: string]: string[] }, current_name?: string, seen_names: string[] = []): boolean => {
  const next_name = current_name || search_name;
  const dependencies = depends_on_map[next_name];

  if (seen_names.includes(next_name)) {
    return false;
  }

  seen_names.push(next_name);

  if (!dependencies?.length) {
    return false;
  }

  for (const dependency of dependencies) {
    if (dependency === search_name) {
      return true;
    } else if (isPartOfCircularReference(search_name, depends_on_map, dependency, seen_names)) {
      return true;
    }
  }

  return false;
};

export const validateDependsOn = (component: ComponentSpec): ValidationError[] => {
  const errors = [];
  const depends_on_map: { [name: string]: string[] } = {};

  for (const [name, service] of Object.entries(component.services || {})) {
    depends_on_map[name] = service.depends_on || [];
  }

  const task_map: { [name: string]: boolean } = {};
  for (const [name, service] of Object.entries(component.tasks || {})) {
    depends_on_map[name] = service.depends_on || [];
    task_map[name] = true;
  }

  for (const [name, dependencies] of Object.entries(depends_on_map)) {
    for (const dependency of dependencies) {

      if (task_map[dependency]) {
        const error = new ValidationError({
          component: component.name,
          path: `services.${name}.depends_on`,
          message: `services.${name}.depends_on.${dependency} must refer to a service, not a task`,
          value: dependency,
        });
        errors.push(error);
      }

      if (!depends_on_map[dependency]) {
        const error = new ValidationError({
          component: component.name,
          path: `services.${name}.depends_on`,
          message: `services.${name}.depends_on.${dependency} must refer to a valid service`,
          value: dependency,
        });
        errors.push(error);
      }
    }
    if (isPartOfCircularReference(name, depends_on_map)) {
      const error = new ValidationError({
        component: component.name,
        path: `services.${name}.depends_on`,
        message: `services.${name}.depends_on must not contain a circular reference`,
        value: depends_on_map[name],
      });
      errors.push(error);
    }
  }

  return errors;
};

export const validateOrRejectSpec = (parsed_yml: ParsedYaml): ComponentSpec => {
  const errors = validateSpec(parsed_yml);

  if (errors && errors.length) {
    throw new ValidationErrors(errors);
  }

  const component_spec = plainToClass(ComponentSpec, parsed_yml);
  component_spec.metadata = {
    ref: `${component_spec.name}:latest`,
    tag: 'latest',
    instance_date: new Date(),
    proxy_port_mapping: {},
  };

  errors.push(...validateServiceAndTaskKeys(component_spec));
  errors.push(...validateDependsOn(component_spec));

  if (errors && errors.length) {
    throw new ValidationErrors(errors);
  }

  return component_spec;
};
