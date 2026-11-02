// A grammar validator for GitHub Actions expressions, written against the
// documented language (docs.github.com, "Evaluate expressions in workflows
// and actions"). The Actions runner parses the whole workflow file before any
// job starts, so one invalid expression fails every run of the workflow
// before it begins; the regex match operator the branch CI gate once used
// was rejected exactly that way. GitHub expressions have no regex operator,
// no arithmetic and no ternary, so anything outside the grammar below is
// rejected here, in the hook suite, before it can reach GitHub.

const CONTEXTS = new Set([
  'github',
  'env',
  'vars',
  'job',
  'jobs',
  'steps',
  'runner',
  'secrets',
  'strategy',
  'matrix',
  'needs',
  'inputs',
]);

const FUNCTIONS = new Set([
  'contains',
  'startsWith',
  'endsWith',
  'format',
  'join',
  'toJSON',
  'fromJSON',
  'hashFiles',
  'case',
  'success',
  'always',
  'failure',
  'cancelled',
]);

const KEYWORDS = new Set(['true', 'false', 'null']);

const twoCharacterOperators = ['==', '!=', '>=', '<=', '&&', '||'];
const comparisonOperators = ['==', '!=', '<', '<=', '>', '>='];
const numberPattern = /^-?(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/;
const namePattern = /^[A-Za-z_][A-Za-z0-9_-]*/;

function tokenize(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }
    const pair = source.slice(index, index + 2);
    if (twoCharacterOperators.includes(pair)) {
      tokens.push({ type: 'operator', value: pair });
      index += 2;
      continue;
    }
    const character = source[index];
    if ('!<>[]()*.,'.includes(character)) {
      tokens.push({ type: 'symbol', value: character });
      index += 1;
      continue;
    }
    if (character === "'") {
      let value = '';
      index += 1;
      for (;;) {
        if (index >= source.length)
          throw new Error('Unterminated string literal.');
        if (source[index] === "'") {
          if (source[index + 1] === "'") {
            value += "'";
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        value += source[index];
        index += 1;
      }
      tokens.push({ type: 'string', value });
      continue;
    }
    const numeric = numberPattern.exec(source.slice(index));
    if (numeric) {
      tokens.push({ type: 'number', value: numeric[0] });
      index += numeric[0].length;
      continue;
    }
    const identifier = namePattern.exec(source.slice(index));
    if (identifier) {
      tokens.push({ type: 'name', value: identifier[0] });
      index += identifier[0].length;
      continue;
    }
    throw new Error(
      `Unexpected character ${JSON.stringify(character)} at offset ${index}.`,
    );
  }
  return tokens;
}

// Accepts one expression, with or without the ${{ }} wrapper, and throws on
// anything outside the documented grammar.
export function parseExpression(source) {
  let text = String(source).trim();
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(text);
  if (wrapped) text = wrapped[1].trim();
  const tokens = tokenize(text);
  let position = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++];
  const isOperator = (token, values) =>
    token?.type === 'operator' && values.includes(token.value);
  const isSymbol = (token, value) =>
    token?.type === 'symbol' && token.value === value;
  const expectSymbol = (value) => {
    const token = take();
    if (!isSymbol(token, value))
      throw new Error(
        `Expected '${value}'${
          token ? `, received '${token.value}'` : ' at the end'
        }.`,
      );
  };

  function parseDereference() {
    for (;;) {
      if (isSymbol(peek(), '.')) {
        take();
        const property = take();
        if (!isSymbol(property, '*') && property?.type !== 'name')
          throw new Error("Expected a property name or '*' after the dot.");
        continue;
      }
      if (isSymbol(peek(), '[')) {
        take();
        if (isSymbol(peek(), '*')) take();
        else parseOr();
        expectSymbol(']');
        continue;
      }
      return;
    }
  }

  function parsePrimary() {
    const token = take();
    if (!token) throw new Error('The expression ends without a value.');
    if (token.type === 'string' || token.type === 'number') return;
    if (isSymbol(token, '(')) {
      parseOr();
      expectSymbol(')');
      return;
    }
    if (token.type === 'name') {
      if (KEYWORDS.has(token.value.toLowerCase())) return;
      if (isSymbol(peek(), '(')) {
        if (
          ![...FUNCTIONS].some(
            (name) => name.toLowerCase() === token.value.toLowerCase(),
          )
        )
          throw new Error(`Unknown function '${token.value}'.`);
        take();
        if (isSymbol(peek(), ')')) {
          take();
          return;
        }
        for (;;) {
          parseOr();
          if (isSymbol(peek(), ',')) {
            take();
            continue;
          }
          break;
        }
        expectSymbol(')');
        return;
      }
      if (!CONTEXTS.has(token.value.toLowerCase()))
        throw new Error(`Unknown context '${token.value}'.`);
      parseDereference();
      return;
    }
    throw new Error(`Unexpected token '${token.value}'.`);
  }

  function parseUnary() {
    if (isSymbol(peek(), '!')) {
      take();
      parseUnary();
      return;
    }
    parsePrimary();
  }

  function parseComparison() {
    parseUnary();
    if (isOperator(peek(), comparisonOperators)) {
      take();
      parseUnary();
    }
  }

  function parseAnd() {
    parseComparison();
    while (isOperator(peek(), ['&&'])) {
      take();
      parseComparison();
    }
  }

  function parseOr() {
    parseAnd();
    while (isOperator(peek(), ['||'])) {
      take();
      parseAnd();
    }
  }

  parseOr();
  const trailing = peek();
  if (trailing) throw new Error(`Unexpected token '${trailing.value}'.`);
  return true;
}
