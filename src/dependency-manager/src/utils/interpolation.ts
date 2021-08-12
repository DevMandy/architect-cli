import Mustache, { Context, Writer } from 'mustache';
import { flattenValidationErrorsWithLineNumbers, ValidationError, ValidationErrors } from './errors';

// https://github.com/janl/mustache.js/issues/599
export const ARC_NULL_TOKEN = '__arc__null__arc__';
const null_quoted_regex = new RegExp(`"${ARC_NULL_TOKEN}"`, 'g');
const null_regex = new RegExp(`${ARC_NULL_TOKEN}`, 'g');

// TODO:320 test
export const normalizeInterpolation = (value: string) => {
  return value.replace(/\./g, '__arc__');
};

export const denormalizeInterpolation = (value: string) => {
  return value.replace(/__arc__/g, '.');
};

/*
Mustache doesn't respect bracket key lookups. This method transforms the following:
${{ dependencies['architect/cloud'].services }} -> ${{ dependencies.architect/cloud.services }}
${{ dependencies["architect/cloud"].services }} -> ${{ dependencies.architect/cloud.services }}
*/
export const replaceBrackets = (value: string) => {
  const mustache_regex = new RegExp(`\\\${{(.*?)}}`, 'g');
  let matches;
  let res = value;
  while ((matches = mustache_regex.exec(value)) != null) {
    const sanitized_value = matches[0].replace(/\[["|']?([^\]|"|']+)["|']?\]/g, '.$1');
    res = res.replace(matches[0], sanitized_value);
  }
  return res;
};

export const escapeJSON = (value: any) => {
  if (value instanceof Object) {
    value = JSON.stringify(value);
  }

  // Support json strings
  try {
    const escaped = JSON.stringify(value);
    if (`${value}` !== escaped) {
      value = escaped.substr(1, escaped.length - 2);
    }
    // eslint-disable-next-line no-empty
  } catch { }
  return value;
};

Mustache.escape = function (text) {
  return escapeJSON(text);
}; // turns off HTML escaping
Mustache.tags = ['${{', '}}']; // sets custom delimiters
Mustache.templateCache = undefined;

export const interpolateString = (param_value: string, context: any, ignore_keys: string[] = [], max_depth = 25): string => {
  const writer = new Writer();
  const errors: Set<string> = new Set();

  const render = writer.render;
  writer.render = function (template, view, partials) {

    view = new Context(view, undefined);
    const lookup = view.lookup;
    view.lookup = function (name: string) {
      const value = lookup.bind(this)(name);
      if (value === undefined) {
        const ignored = ignore_keys.some((k) => name.startsWith(k));
        if (!ignored) {
          errors.add(name);
        }
      }
      return value;
    };

    const result = render.bind(this)(template, view, partials);
    if (errors.size > 0) {
      const interpolation_errors: Set<string> = new Set();
      for (const error of errors) {
        // Dedupe host/port/protocol/username/password into url
        if (error.endsWith('.host') || error.endsWith('.port') || error.endsWith('.protocol') || error.endsWith('.username') || error.endsWith('.password')) {
          const keys = error.split('.');
          const key = keys.slice(0, keys.length - 1).join('.');
          if (errors.has(`${key}.host`) && errors.has(`${key}.port`) && errors.has(`${key}.protocol`)) {
            interpolation_errors.add(`${key}.url`);
          } else {
            interpolation_errors.add(error);
          }
        } else {
          interpolation_errors.add(error);
        }
      }

      const validation_error = new ValidationError();
      validation_error.property = 'interpolation';
      validation_error.children = [];
      for (let e of interpolation_errors) {
        e = denormalizeInterpolation(e);
        const interpolation_error = new ValidationError();
        interpolation_error.property = e;
        interpolation_error.value = e;
        interpolation_error.children = [];
        interpolation_error.constraints = {
          'interpolation': `\${{ ${e} }} is invalid`,
        };
        validation_error.children.push(interpolation_error);
      }
      throw new ValidationErrors('values', flattenValidationErrorsWithLineNumbers([validation_error], param_value));
    }

    return result.replace(null_quoted_regex, 'null').replace(null_regex, 'null');
  };

  const mustache_regex = new RegExp(`\\\${{(.*?)}}`, 'g');
  let depth = 0;
  while (depth < max_depth) {
    param_value = replaceBrackets(param_value);
    param_value = writer.render(param_value, context);
    if (!mustache_regex.test(param_value)) break;
    depth += 1;
  }

  return param_value;
};


