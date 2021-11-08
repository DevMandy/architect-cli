import { isIdentifierChar, isIdentifierStart } from 'acorn';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { LooseParser } from 'acorn-loose';
import estraverse from 'estraverse';
import { EXPRESSION_REGEX } from '../spec/utils/interpolation';
import { matches } from './interpolation';

function isIdentifier(node: any): boolean {
  if (node.type === 'Identifier') {
    return true;
  } else if (node.type === 'MemberExpression') {
    return true;
  } else {
    return false;
  }
}

function parseIdentifier(node: any): string {
  if (node.type === 'Identifier') {
    return node.name;
  }
  const res = [];
  while (node.type === 'MemberExpression') {
    res.unshift(node.property.name || node.property.value);
    if (node.object.type === 'Identifier') {
      res.unshift(node.object.name);
    }
    node = node.object;
  }
  return res.join('.');
}

function codePointToString(code: number) {
  // UTF-16 Decoding
  if (code <= 0xFFFF) return String.fromCharCode(code);
  code -= 0x10000;
  return String.fromCharCode((code >> 10) + 0xD800, (code & 1023) + 0xDC00);
}

function getArchitectParser(Parser: any) {
  return class extends Parser {
    // https://github.com/acornjs/acorn/blob/27f01d6dccfd193ee4d892140b5e5844a83f0073/acorn/src/tokenize.js#L776
    readWord1() {
      this.containsEsc = false;
      let word = "", first = true, chunkStart = this.pos;
      const astral = this.options.ecmaVersion >= 6;
      while (this.pos < this.input.length) {
        const ch = this.fullCharCodeAtPos();
        if (isIdentifierChar(ch, astral) || ch === 45 || ch === 47) {  // Override to support '-' or '/'
          this.pos += ch <= 0xffff ? 1 : 2;
        } else if (ch === 92) { // "\"
          this.containsEsc = true;
          word += this.input.slice(chunkStart, this.pos);
          const escStart = this.pos;
          if (this.input.charCodeAt(++this.pos) !== 117) // "u"
            this.invalidStringToken(this.pos, "Expecting Unicode escape sequence \\uXXXX");
          ++this.pos;
          const esc = this.readCodePoint();
          if (!(first ? isIdentifierStart : isIdentifierChar)(esc, astral))
            this.invalidStringToken(escStart, "Invalid Unicode escape");
          word += codePointToString(esc);
          chunkStart = this.pos;
        } else {
          break;
        }
        first = false;
      }
      return word + this.input.slice(chunkStart, this.pos);
    }
  };
}

LooseParser.BaseParser = LooseParser.BaseParser.extend(getArchitectParser);

export function parseExpression(program: string, context: any, ignore_keys: string[] = [], max_depth = 25): any {
  const ast = LooseParser.parse(program, { ecmaVersion: 2020 });

  estraverse.replace(ast, {
    enter: function (node: any, parent: any) {
      if (node.type === 'EmptyStatement') {
        return estraverse.VisitorOption.Remove;
      }

      if (isIdentifier(node)) {
        // Function callee identifier
        if (parent?.callee === node) {
          return {
            type: 'Literal',
            value: node.name,
          };
        }
        const context_key = parseIdentifier(node);
        const value = context[context_key];

        if (value === undefined) {
          const ignored = ignore_keys.some((k) => context_key.startsWith(k));
          if (!ignored) {
            // misses.add(interpolation_ref);
            throw new Error(`Invalid context key: ${context_key}`);
          }
        }
        return {
          type: 'Literal',
          // TODO:333 detect loop
          // eslint-disable-next-line @typescript-eslint/no-use-before-define
          value: parseString(context[context_key], context, ignore_keys, max_depth),
        };
      }
    },
    leave: function (node: any, parent: any) {
      if (node.type === 'ExpressionStatement') {
        return {
          type: 'Literal',
          value: node.expression.value,
        };
      }
      if (node.type === 'UnaryExpression') {
        let value: boolean | number;
        if (node.operator === '!') {
          value = !node.argument.value;
        } else if (node.operator === '-') {
          value = -node.argument.value;
        } else {
          throw new Error(`Unsupported node.operator: ${node.operator} node.type: ${node.type}`);
        }
        return {
          type: 'Literal',
          value: value,
        };
      } else if (node.type === 'ConditionalExpression') {
        return {
          type: 'Literal',
          value: node.test.value ? node.consequent.value : node.alternative.value,
        };
      } else if (node.type === 'BinaryExpression') {
        const left_value = node.left.value;
        const right_value = node.right.value;
        let value: boolean | number | string;
        if (node.operator === '==') {
          value = left_value === right_value;
        } else if (node.operator === '!=') {
          value = left_value !== right_value;
        } else if (node.operator === '>') {
          value = left_value > right_value;
        } else if (node.operator === '>=') {
          value = left_value >= right_value;
        } else if (node.operator === '<') {
          value = left_value < right_value;
        } else if (node.operator === '<=') {
          value = left_value <= right_value;
        } else if (node.operator === '+') {
          value = left_value + right_value;
        } else if (node.operator === '-') {
          value = left_value - right_value;
        } else if (node.operator === '*') {
          value = left_value * right_value;
        } else if (node.operator === '/') {
          value = left_value / right_value;
        } else {
          throw new Error(`Unsupported node.operator: ${node.operator} node.type: ${node.type}`);
        }
        return {
          type: 'Literal',
          value: value,
        };
      } else if (node.type === 'LogicalExpression') {
        const left_value = node.left.value;
        const right_value = node.right.value;
        let value: boolean;
        if (node.operator === '&&') {
          value = left_value && right_value;
        } else if (node.operator === '||') {
          value = left_value || right_value;
        } else {
          throw new Error(`Unsupported node.operator: ${node.operator} node.type: ${node.type}`);
        }
        return {
          type: 'Literal',
          value: value,
        };
      } else if (node.type == 'CallExpression') {
        let value;
        if (node.callee.value === 'trim') {
          value = node.arguments[0].value.trim();
        } else {
          throw new Error(`Unsupported node.callee.value: ${node.callee.value} node.type: ${node.type}`);
        }
        return {
          type: 'Literal',
          value: value,
        };
      } else if (node.type == 'IfStatement') {
        if (node.test.type === 'Literal') {
          return {
            type: 'Literal',
            value: !!node.test.value,
          };
        } else {
          throw new Error(`Unsupported node.test.type: ${node.test.type}`);
        }
      } else if (node.type !== 'Literal' && node.type !== 'Program') {
        throw new Error(`Unsupported node.type: ${node.type}`);
      }
    },
  });

  return ast;
}

export function parseString(program: string, context: any, ignore_keys: string[] = [], max_depth = 25): any {
  let res = program;

  let last_value;

  for (const match of matches(program, EXPRESSION_REGEX)) {
    const ast = parseExpression(match[1], context, ignore_keys, max_depth);
    res = res.replace(match[0], ast.body[0].value);
    last_value = ast.body[0].value;
  }

  // Handle case where value a number or boolean. Ex ${{ parameters.replicas }} is a number
  if (res === `${last_value}`) {
    return last_value;
  }

  return res;
}
