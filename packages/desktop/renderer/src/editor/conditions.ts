/** Minimal branch-condition evaluator mirroring the workflow engine's parser. */

const OPERATORS = ['>=', '<=', '==', '!=', '>', '<'] as const;

export function evaluateCondition(expression: string, state: Record<string, unknown>): boolean {
  if (expression === 'default') return true;
  const trimmed = expression.trim();
  const operator = OPERATORS.find((op) => trimmed.includes(op));
  if (!operator) throw new Error(`Unsupported condition expression: '${expression}'`);
  const index = trimmed.indexOf(operator);
  const path = trimmed.slice(0, index).trim();
  const rawValue = trimmed.slice(index + operator.length).trim();
  if (!/^[$a-zA-Z_][\w.]*$/.test(path) || rawValue.length === 0) {
    throw new Error(`Unsupported condition expression: '${expression}'`);
  }

  let left: unknown = state;
  for (const key of path.split('.')) {
    left = (left as Record<string, unknown> | undefined)?.[key];
  }

  let right: unknown;
  if (rawValue === 'true') right = true;
  else if (rawValue === 'false') right = false;
  else if (rawValue === 'null') right = null;
  else if (!Number.isNaN(Number(rawValue))) right = Number(rawValue);
  else right = rawValue.replace(/^['"]|['"]$/g, '');

  switch (operator) {
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    case '>=':
      return Number(left) >= Number(right);
    case '<=':
      return Number(left) <= Number(right);
    case '>':
      return Number(left) > Number(right);
    case '<':
      return Number(left) < Number(right);
    default:
      throw new Error(`Unsupported operator: '${operator}'`);
  }
}
