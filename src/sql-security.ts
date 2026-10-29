// This policy consumes DuckDB's own JSON AST, not a second SQL grammar.
// Unknown syntax/fields fail closed. Extend it only with parser-backed tests.
export class SQLValidationError extends Error {
  constructor(message: string) { super(`SQL rejected: ${message}`); this.name = 'SQLValidationError'; }
}

const ALLOWED_FUNCTIONS = new Set([
  'count', 'count_star', 'avg', 'sum', 'min', 'max', 'round', 'abs', 'floor', 'ceil',
  'ceiling', 'nullif', 'date_trunc', 'date_part', 'date_diff', 'datediff',
  'strftime', 'year', 'month', 'day', 'hour', 'minute', 'second',
  'lower', 'upper', 'length', 'trim', '+', '-', '*', '/', '%',
]);
const TYPES = new Set(['NULL', 'BOOLEAN', 'TINYINT', 'SMALLINT', 'INTEGER', 'BIGINT',
  'HUGEINT', 'UTINYINT', 'USMALLINT', 'UINTEGER', 'UBIGINT', 'FLOAT', 'DOUBLE',
  'DECIMAL', 'VARCHAR', 'DATE', 'TIME', 'TIMESTAMP', 'INTERVAL']);
const COMPARISONS = new Set(['COMPARE_EQUAL', 'COMPARE_NOTEQUAL', 'COMPARE_LESSTHAN',
  'COMPARE_GREATERTHAN', 'COMPARE_LESSTHANOREQUALTO', 'COMPARE_GREATERTHANOREQUALTO',
  'COMPARE_DISTINCT_FROM', 'COMPARE_NOT_DISTINCT_FROM']);
type ObjectNode = Record<string, unknown>;
const reject = (message: string): never => { throw new SQLValidationError(message); };
function object(value: unknown): ObjectNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject('Unexpected parser structure.');
  return value as ObjectNode;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) return reject('Unexpected parser list.');
  return value;
}
function keys(node: ObjectNode, allowed: string[]) {
  for (const key of Object.keys(node)) if (!allowed.includes(key)) reject(`Unsupported parser field: ${key}.`);
}
function empty(value: unknown) {
  if (value !== null && value !== undefined && value !== '' && value !== false &&
      !(Array.isArray(value) && value.length === 0)) reject('Unsupported SQL feature.');
}
function strings(value: unknown) {
  const items = list(value);
  if (items.some((item) => typeof item !== 'string')) reject('Invalid identifier list.');
  return items as string[];
}
function dataType(value: unknown) {
  const type = object(value);
  keys(type, ['id', 'type_info']);
  if (!TYPES.has(String(type.id))) reject(`Unsupported data type: ${String(type.id)}.`);
  if (type.type_info != null) {
    const info = object(type.type_info);
    keys(info, ['type', 'alias', 'extension_info', 'width', 'scale']);
    if (type.id !== 'DECIMAL' || info.type !== 'DECIMAL_TYPE_INFO') reject('Custom types are not allowed.');
    empty(info.alias); empty(info.extension_info);
  }
}

export function checkSQLLength(sql: string) {
  if (!sql.trim() || sql.length > 20_000) reject('Enter one query of at most 20,000 characters.');
}

export function validateAST(value: unknown): void {
  let visited = 0;
  function budget(depth: number) {
    if (++visited > 5_000 || depth > 64) reject('Query structure is too complex.');
  }
  function statement(value: unknown, scope: Set<string>, depth: number) {
    budget(depth);
    const statement = object(value);
    keys(statement, ['node', 'named_param_map']);
    empty(statement.named_param_map);
    select(statement.node, scope, depth + 1);
  }
  function select(value: unknown, inherited: Set<string>, depth: number) {
    budget(depth);
    const node = object(value);
    keys(node, ['type', 'modifiers', 'cte_map', 'select_list', 'from_table', 'where_clause',
      'group_expressions', 'group_sets', 'aggregate_handling', 'having', 'sample', 'qualify']);
    if (node.type !== 'SELECT_NODE') reject('Only ordinary SELECT queries are supported (no recursive CTEs or set operations).');
    if (node.aggregate_handling !== 'STANDARD_HANDLING') reject('Unsupported aggregate syntax.');
    empty(node.sample); empty(node.qualify);
    const scope = new Set(inherited);
    const ctes = object(node.cte_map);
    keys(ctes, ['map']);
    const local = new Set<string>();
    for (const item of list(ctes.map)) {
      const entry = object(item); keys(entry, ['key', 'value']);
      if (typeof entry.key !== 'string') reject('Invalid CTE name.');
      const name = String(entry.key).toLowerCase();
      if (name === 'trips' || local.has(name)) reject('CTEs cannot shadow trips or repeat a name.');
      const cte = object(entry.value);
      keys(cte, ['aliases', 'query', 'materialized', 'key_targets']);
      strings(cte.aliases); empty(cte.key_targets);
      if (!['CTE_MATERIALIZE_DEFAULT', 'CTE_MATERIALIZE_ALWAYS', 'CTE_MATERIALIZE_NEVER'].includes(String(cte.materialized))) reject('Unsupported CTE mode.');
      // Only earlier CTEs are visible: self/forward recursion is unsupported.
      const definitionScope = new Set(scope); definitionScope.delete(name);
      statement(cte.query, definitionScope, depth + 1);
      scope.add(name); local.add(name);
    }
    table(node.from_table, scope, depth + 1);
    for (const expr of list(node.select_list)) expression(expr, scope, depth + 1);
    for (const expr of list(node.group_expressions)) expression(expr, scope, depth + 1);
    for (const set of list(node.group_sets)) for (const index of list(set)) {
      if (!Number.isInteger(index)) reject('Unsupported grouping set.');
    }
    optional(node.where_clause, scope, depth + 1);
    optional(node.having, scope, depth + 1);
    for (const modifier of list(node.modifiers)) modifiers(modifier, scope, depth + 1);
  }
  function table(value: unknown, scope: Set<string>, depth: number) {
    budget(depth);
    const node = object(value);
    if (node.type === 'BASE_TABLE') {
      keys(node, ['type', 'alias', 'sample', 'query_location', 'schema_name', 'table_name', 'column_name_alias', 'catalog_name', 'at_clause']);
      empty(node.schema_name); empty(node.catalog_name); empty(node.at_clause); empty(node.sample);
      strings(node.column_name_alias);
      const name = String(node.table_name).toLowerCase();
      if (name !== 'trips' && !scope.has(name)) reject('Only trips and validated in-scope CTEs may be queried.');
    } else if (node.type === 'SUBQUERY') {
      keys(node, ['type', 'alias', 'sample', 'query_location', 'subquery', 'column_name_alias']);
      empty(node.sample); strings(node.column_name_alias);
      statement(node.subquery, scope, depth + 1);
    } else if (node.type === 'EMPTY') {
      keys(node, ['type', 'alias', 'sample', 'query_location']); empty(node.sample);
    } else reject('Table functions, joins, file paths, and other table sources are not allowed.');
  }
  function optional(value: unknown, scope: Set<string>, depth: number) {
    if (value != null) expression(value, scope, depth);
  }
  function modifiers(value: unknown, scope: Set<string>, depth: number) {
    const node = object(value);
    if (node.type === 'ORDER_MODIFIER') {
      keys(node, ['type', 'orders']);
      for (const item of list(node.orders)) {
        const order = object(item); keys(order, ['type', 'null_order', 'expression']);
        if (!['ORDER_DEFAULT', 'ASCENDING', 'DESCENDING'].includes(String(order.type)) ||
            !['ORDER_DEFAULT', 'NULLS_FIRST', 'NULLS_LAST'].includes(String(order.null_order))) reject('Unsupported ordering.');
        expression(order.expression, scope, depth + 1);
      }
    } else if (node.type === 'LIMIT_MODIFIER') {
      keys(node, ['type', 'limit', 'offset']);
      optional(node.limit, scope, depth + 1); optional(node.offset, scope, depth + 1);
    } else if (node.type === 'DISTINCT_MODIFIER') {
      keys(node, ['type', 'distinct_on_targets']);
      for (const expr of list(node.distinct_on_targets)) expression(expr, scope, depth + 1);
    } else reject('Unsupported SELECT modifier.');
  }
  function expression(value: unknown, scope: Set<string>, depth: number) {
    budget(depth);
    const node = object(value);
    const base = ['class', 'type', 'alias', 'query_location'];
    switch (node.class) {
      case 'CONSTANT': {
        keys(node, [...base, 'value']);
        if (node.type !== 'VALUE_CONSTANT') reject('Unsupported constant.');
        const constant = object(node.value); keys(constant, ['type', 'is_null', 'value']);
        dataType(constant.type);
        if (constant.value != null && !['string', 'number', 'boolean'].includes(typeof constant.value)) reject('Unsupported constant value.');
        break;
      }
      case 'COLUMN_REF':
        keys(node, [...base, 'column_names']);
        if (node.type !== 'COLUMN_REF' || strings(node.column_names).length > 2) reject('Unsupported column reference.');
        break;
      case 'STAR':
        keys(node, [...base, 'relation_name', 'exclude_list', 'replace_list', 'columns', 'expr', 'qualified_exclude_list', 'rename_list']);
        if (node.type !== 'STAR') reject('Unsupported star expression.');
        for (const key of ['exclude_list', 'replace_list', 'columns', 'expr', 'qualified_exclude_list', 'rename_list']) empty(node[key]);
        break;
      case 'FUNCTION':
        keys(node, [...base, 'function_name', 'schema', 'children', 'filter', 'order_bys', 'distinct', 'is_operator', 'export_state', 'catalog']);
        if (node.type !== 'FUNCTION' || !ALLOWED_FUNCTIONS.has(String(node.function_name).toLowerCase())) reject(`Function is not allowed: ${String(node.function_name)}.`);
        empty(node.schema); empty(node.catalog); empty(node.export_state);
        for (const child of list(node.children)) expression(child, scope, depth + 1);
        optional(node.filter, scope, depth + 1); modifiers(node.order_bys, scope, depth + 1);
        break;
      case 'CAST':
        keys(node, [...base, 'child', 'cast_type', 'try_cast']);
        if (node.type !== 'OPERATOR_CAST') reject('Unsupported cast.');
        dataType(node.cast_type); expression(node.child, scope, depth + 1); break;
      case 'COMPARISON':
        keys(node, [...base, 'left', 'right']);
        if (!COMPARISONS.has(String(node.type))) reject('Unsupported comparison.');
        expression(node.left, scope, depth + 1); expression(node.right, scope, depth + 1); break;
      case 'CONJUNCTION':
      case 'OPERATOR':
        keys(node, [...base, 'children']);
        if (!['CONJUNCTION_AND', 'CONJUNCTION_OR', 'OPERATOR_NOT', 'OPERATOR_IS_NULL', 'OPERATOR_IS_NOT_NULL', 'OPERATOR_COALESCE', 'COMPARE_IN', 'COMPARE_NOT_IN'].includes(String(node.type))) reject('Unsupported operator.');
        for (const child of list(node.children)) expression(child, scope, depth + 1);
        break;
      case 'BETWEEN':
        keys(node, [...base, 'input', 'lower', 'upper']);
        if (node.type !== 'COMPARE_BETWEEN') reject('Unsupported BETWEEN.');
        for (const key of ['input', 'lower', 'upper']) expression(node[key], scope, depth + 1);
        break;
      case 'CASE':
        keys(node, [...base, 'case_checks', 'else_expr']);
        if (node.type !== 'CASE_EXPR') reject('Unsupported CASE.');
        for (const item of list(node.case_checks)) {
          const check = object(item); keys(check, ['when_expr', 'then_expr']);
          expression(check.when_expr, scope, depth + 1); expression(check.then_expr, scope, depth + 1);
        }
        optional(node.else_expr, scope, depth + 1); break;
      case 'SUBQUERY':
        keys(node, [...base, 'subquery_type', 'subquery', 'child', 'comparison_type']);
        if (node.type !== 'SUBQUERY' || !['SCALAR', 'EXISTS', 'NOT_EXISTS', 'ANY'].includes(String(node.subquery_type))) reject('Unsupported subquery.');
        if (node.comparison_type !== 'INVALID' && !COMPARISONS.has(String(node.comparison_type))) reject('Unsupported subquery comparison.');
        statement(node.subquery, scope, depth + 1); optional(node.child, scope, depth + 1); break;
      default: reject(`Unsupported expression: ${String(node.class)}.`);
    }
  }
  const document = object(value);
  if (document.error !== false) reject('Cannot parse as SELECT-only SQL.');
  keys(document, ['error', 'statements']);
  const statements = list(document.statements);
  if (statements.length !== 1) reject('Exactly one SQL statement is allowed.');
  statement(statements[0], new Set(), 0);
}

// The only untrusted execution path: parse as data, validate, then run that exact string.
export async function validatedQuery<T>(sql: string, parse: (sql: string) => Promise<unknown>, execute: (sql: string) => Promise<T>): Promise<T> {
  checkSQLLength(sql);
  let ast: unknown;
  try { ast = await parse(sql); } catch (error) {
    return reject(`SQL parsing failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateAST(ast);
  return execute(sql);
}
