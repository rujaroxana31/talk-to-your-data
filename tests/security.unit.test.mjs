import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAST, validatedQuery, checkSQLLength, SQLValidationError } from '../src/sql-security.ts';

const column = { class: 'COLUMN_REF', type: 'COLUMN_REF', column_names: ['VendorID'] };
const baseTable = { type: 'BASE_TABLE', table_name: 'trips', schema_name: '', catalog_name: '', at_clause: null, sample: null, column_name_alias: [] };
const document = () => ({ error: false, statements: [{ node: {
  type: 'SELECT_NODE', cte_map: { map: [] }, select_list: [structuredClone(column)],
  from_table: structuredClone(baseTable), modifiers: [], group_expressions: [], group_sets: [],
  aggregate_handling: 'STANDARD_HANDLING', sample: null, qualify: null, where_clause: null, having: null,
}, named_param_map: [] }] });

test('known AST accepted', () => assert.doesNotThrow(() => validateAST(document())));
for (const [name, change] of [
  ['parser error', (d) => { d.error = true; }],
  ['stacked AST', (d) => { d.statements.push(structuredClone(d.statements[0])); }],
  ['unknown root field', (d) => { d.new_feature = {}; }],
  ['unknown executable field', (d) => { d.statements[0].node.new_clause = column; }],
  ['unknown statement node', (d) => { d.statements[0].node.type = 'DELETE_NODE'; }],
  ['table function', (d) => { d.statements[0].node.from_table = { type: 'TABLE_FUNCTION' }; }],
  ['catalog escape', (d) => { d.statements[0].node.from_table.catalog_name = 'other'; }],
  ['schema escape', (d) => { d.statements[0].node.from_table.schema_name = 'information_schema'; }],
  ['unapproved table', (d) => { d.statements[0].node.from_table.table_name = 'private'; }],
  ['out-of-scope CTE', (d) => { d.statements[0].node.from_table.table_name = 'x'; }],
  ['unknown expression', (d) => { d.statements[0].node.select_list = [{ class: 'LAMBDA' }]; }],
  ['star replacement', (d) => { d.statements[0].node.select_list = [{ class: 'STAR', type: 'STAR', replace_list: [column] }]; }],
]) test(`fail closed: ${name}`, () => {
  const d = document(); change(d); assert.throws(() => validateAST(d), SQLValidationError);
});
test('input size checked before parser', async () => {
  let parsed = false;
  await assert.rejects(validatedQuery('x'.repeat(20001), async () => { parsed = true; }, async () => {}), SQLValidationError);
  assert.equal(parsed, false); assert.throws(() => checkSQLLength('  '), SQLValidationError);
});
test('parser failure never executes SQL', async () => {
  let calls = 0;
  await assert.rejects(validatedQuery('SELECT 1', async () => { throw new Error('unavailable'); }, async () => { calls++; }), SQLValidationError);
  assert.equal(calls, 0);
});
test('rejected AST never executes SQL', async () => {
  let calls = 0;
  await assert.rejects(validatedQuery('SELECT 1', async () => ({ error: true }), async () => { calls++; }), SQLValidationError);
  assert.equal(calls, 0);
});
test('approved exact input executed once', async () => {
  const sql = 'SELECT VendorID FROM trips'; const calls = [];
  await validatedQuery(sql, async (input) => { assert.equal(input, sql); return document(); }, async (input) => { calls.push(input); });
  assert.deepEqual(calls, [sql]);
});
