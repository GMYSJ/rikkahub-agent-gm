/**
 * 脱宿主冒烟测试：不依赖 DSH 宿主即可跑，验证协议与 schema 层的纯逻辑。
 *
 * 运行：node test/smoke.mjs
 */

import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION,
  MAX_HOP_COUNT,
  ERROR_CODE,
  HEADER,
  parseTrace,
  checkHopBudget,
  buildOutboundHeaders,
  newTraceId,
  okEnvelope,
  errorEnvelope,
  validateWireTool,
  qualifyToolName,
  parseQualifiedToolName,
} from '../lib/protocol.js';
import {
  specToJsonSchema,
  propertiesToJsonSchema,
  toolParametersToJsonSchema,
  toolSchemaToWire,
  hasComplexJsonSchemaKeywords,
  jsonSchemaToSpec,
  wireParametersToSpec,
} from '../lib/schema.js';

let passed = 0;
let failed = 0;

/**
 * @param {string} name - 用例名。
 * @param {() => void} body - 用例体。
 */
function test(name, body) {
  try {
    body();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log('\n== protocol: trace 解析 ==');
test('header 名大小写不敏感', () => {
  const trace = parseTrace({ 'X-DSH-Trace-Id': 'abc', 'X-DSH-Hop-Count': '1' });
  assert.equal(trace.traceId, 'abc');
  assert.equal(trace.hopCount, 1);
});
test('缺失 header 时降级为默认值，不抛错', () => {
  const trace = parseTrace({});
  assert.equal(trace.traceId, 'untraced');
  assert.equal(trace.hopCount, 0);
  assert.equal(trace.protocol, PROTOCOL_VERSION);
});
test('header 值数组取第一个', () => {
  const trace = parseTrace({ [HEADER.TRACE_ID]: ['first', 'second'] });
  assert.equal(trace.traceId, 'first');
});
test('非法跳数降级为 0', () => {
  assert.equal(parseTrace({ [HEADER.HOP_COUNT]: 'abc' }).hopCount, 0);
  assert.equal(parseTrace({ [HEADER.HOP_COUNT]: '-3' }).hopCount, 0);
});
test('headers 为 null 不崩', () => {
  assert.equal(parseTrace(null).traceId, 'untraced');
});

console.log('\n== protocol: 循环防护 ==');
test('跳数 0 放行', () => {
  assert.equal(checkHopBudget({ hopCount: 0 }).ok, true);
});
test('跳数达到上限被拒，且错误码是 hop_limit', () => {
  const verdict = checkHopBudget({ hopCount: MAX_HOP_COUNT });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, ERROR_CODE.HOP_LIMIT);
});
test('超上限也拒', () => {
  assert.equal(checkHopBudget({ hopCount: MAX_HOP_COUNT + 5 }).ok, false);
});
test('每次转发跳数 +1，sourceNode 换成自己', () => {
  const headers = buildOutboundHeaders({
    trace: { traceId: 't1', hopCount: 0 },
    selfNodeId: 'win',
    targetNodeId: 'phone',
  });
  assert.equal(headers[HEADER.HOP_COUNT], '1');
  assert.equal(headers[HEADER.SOURCE_NODE], 'win');
  assert.equal(headers[HEADER.TARGET_NODE], 'phone');
  assert.equal(headers[HEADER.TRACE_ID], 't1');
});
test('连续转发两次后达到上限，第三次会被拒', () => {
  let trace = { traceId: 't2', hopCount: 0 };
  trace = { traceId: trace.traceId, hopCount: Number(buildOutboundHeaders({ trace, selfNodeId: 'a', targetNodeId: 'b' })[HEADER.HOP_COUNT]) };
  assert.equal(checkHopBudget(trace).ok, true);
  trace = { traceId: trace.traceId, hopCount: Number(buildOutboundHeaders({ trace, selfNodeId: 'b', targetNodeId: 'c' })[HEADER.HOP_COUNT]) };
  assert.equal(checkHopBudget(trace).ok, false);
});
test('trace id 永不返回空串', () => {
  const id = newTraceId();
  assert.equal(typeof id, 'string');
  assert.ok(id.length > 0);
});

console.log('\n== protocol: 信封 ==');
test('成功信封', () => {
  assert.deepEqual(okEnvelope({ a: 1 }), { ok: true, result: { a: 1 } });
});
test('undefined 结果转 null，避免 JSON 里丢字段', () => {
  assert.deepEqual(okEnvelope(undefined), { ok: true, result: null });
});
test('失败信封不带空 details', () => {
  const env = errorEnvelope(ERROR_CODE.TOOL_FAILED, 'boom');
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'tool_failed');
  assert.equal('details' in env.error, false);
});

console.log('\n== protocol: wire 工具描述校验 ==');
test('合法描述通过', () => {
  const verdict = validateWireTool({ name: 'fs_read', description: 'd', parameters: { type: 'object' } });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.tool.name, 'fs_read');
});
test('缺 name 被拒', () => {
  assert.equal(validateWireTool({ description: 'd' }).ok, false);
});
test('空 name 被拒', () => {
  assert.equal(validateWireTool({ name: '   ' }).ok, false);
});
test('超长 name 被拒', () => {
  assert.equal(validateWireTool({ name: 'x'.repeat(129) }).ok, false);
});
test('parameters 是数组被拒', () => {
  assert.equal(validateWireTool({ name: 'a', parameters: [] }).ok, false);
});
test('非对象被拒', () => {
  assert.equal(validateWireTool(null).ok, false);
  assert.equal(validateWireTool('x').ok, false);
});
test('name 被 trim', () => {
  assert.equal(validateWireTool({ name: '  a  ' }).tool.name, 'a');
});

console.log('\n== protocol: 工具名限定 ==');
test('加前缀并可逆', () => {
  const q = qualifyToolName('phone', 'screenshot');
  assert.equal(q, 'mcp__phone__screenshot');
  assert.deepEqual(parseQualifiedToolName(q), { nodeSlug: 'phone', toolName: 'screenshot' });
});
test('非法字符被清洗，保证可逆', () => {
  const q = qualifyToolName('ph one!', 'shot/gun');
  assert.equal(parseQualifiedToolName(q).nodeSlug, 'ph_one_');
  assert.equal(parseQualifiedToolName(q).toolName, 'shot_gun');
});
test('不符合约定的名字返回 null', () => {
  assert.equal(parseQualifiedToolName('bash'), null);
  assert.equal(parseQualifiedToolName(null), null);
});
test('前缀是 mcp__，继承 RikkaHub 的默认审批策略', () => {
  assert.ok(qualifyToolName('x', 'y').startsWith('mcp__'));
});

console.log('\n== schema: DSH spec -> JSON Schema（出方向）==');
test('标量字段直通', () => {
  const out = specToJsonSchema({ type: 'string', description: 'p' });
  assert.equal(out.type, 'string');
  assert.equal(out.description, 'p');
});
test('required: true 被搬到父级 required 数组', () => {
  const out = toolParametersToJsonSchema({
    a: { type: 'string', required: true },
    b: { type: 'number' },
  });
  assert.deepEqual(out.required, ['a']);
  assert.equal(out.properties.b.type, 'number');
});
test('子 schema 里不留 required 键', () => {
  const out = toolParametersToJsonSchema({ a: { type: 'string', required: true } });
  assert.equal('required' in out.properties.a, false);
});
test('嵌套 object 递归处理', () => {
  const out = toolParametersToJsonSchema({
    outer: {
      type: 'object',
      required: true,
      properties: { inner: { type: 'boolean', required: true } },
    },
  });
  assert.equal(out.properties.outer.properties.inner.type, 'boolean');
  assert.deepEqual(out.properties.outer.required, ['inner']);
});
test('array 的 items 递归处理', () => {
  const out = specToJsonSchema({ type: 'array', items: { type: 'string' } });
  assert.equal(out.items.type, 'string');
});
test('type=json 退化成空 schema（任意 JSON）', () => {
  assert.deepEqual(specToJsonSchema({ type: 'json' }), {});
});
test('enum 保留', () => {
  const out = specToJsonSchema({ type: 'string', enum: ['a', 'b'] });
  assert.deepEqual(out.enum, ['a', 'b']);
});
test('toolSchemaToWire 产出完整描述', () => {
  const wire = toolSchemaToWire({
    name: 'todo_write',
    description: 'write todos',
    parameters: { todos: { type: 'array', required: true, items: { type: 'object', properties: { content: { type: 'string', required: true } } } } },
  });
  assert.equal(wire.name, 'todo_write');
  assert.equal(wire.description, 'write todos');
  assert.deepEqual(wire.parameters.required, ['todos']);
  assert.equal(wire.parameters.properties.todos.items.type, 'object');
});

console.log('\n== schema: JSON Schema -> DSH spec（入方向）==');
test('父级 required 数组还原成 required: true', () => {
  const spec = jsonSchemaToSpec({
    type: 'object',
    properties: { a: { type: 'string' } },
    required: ['a'],
  });
  assert.equal(spec.properties.a.required, true);
});
test('非必填字段不带 required', () => {
  const spec = jsonSchemaToSpec({ type: 'object', properties: { a: { type: 'string' } } });
  assert.equal('required' in spec.properties.a, false);
});
test('复杂关键字被识别', () => {
  assert.equal(hasComplexJsonSchemaKeywords({ $ref: '#/x' }), true);
  assert.equal(hasComplexJsonSchemaKeywords({ allOf: [] }), true);
  assert.equal(hasComplexJsonSchemaKeywords({ type: 'string' }), false);
});
test('嵌套里的复杂关键字也能识别', () => {
  assert.equal(hasComplexJsonSchemaKeywords({
    type: 'object',
    properties: { a: { type: 'object', properties: { b: { $ref: '#/y' } } } },
  }), true);
});
test('复杂 schema 退回整份 json，并标记 lossy', () => {
  const result = wireParametersToSpec({
    type: 'object',
    properties: { a: { $ref: '#/x' } },
  });
  assert.equal(result.lossy, true);
  assert.deepEqual(result.spec, {});
});
test('简单 schema 无损转换，且顶层是字段映射而不是包裹结构', () => {
  const result = wireParametersToSpec({
    type: 'object',
    properties: { path: { type: 'string', description: 'abs path' } },
    required: ['path'],
  });
  assert.equal(result.lossy, false);
  // defineTool 要的是 { 字段名: spec }，不能带 type/properties 包裹
  assert.equal('type' in result.spec, false);
  assert.equal('properties' in result.spec, false);
  assert.equal(result.spec.path.type, 'string');
  assert.equal(result.spec.path.required, true);
});
test('空 parameters 返回空 spec 且不算 lossy', () => {
  assert.deepEqual(wireParametersToSpec({ type: 'object', properties: {} }), { spec: {}, lossy: false });
  assert.deepEqual(wireParametersToSpec(null), { spec: {}, lossy: false });
});
test('多类型联合降级为任意 JSON', () => {
  assert.deepEqual(jsonSchemaToSpec({ type: ['string', 'null'] }), {});
});

console.log('\n== schema: 往返一致性 ==');
test('spec -> JSON Schema -> spec 保类型与必填', () => {
  const original = {
    path: { type: 'string', required: true, description: 'p' },
    limit: { type: 'number' },
    tags: { type: 'array', items: { type: 'string' } },
  };
  const jsonSchema = toolParametersToJsonSchema(original);
  const back = jsonSchemaToSpec(jsonSchema);
  assert.equal(back.properties.path.type, 'string');
  assert.equal(back.properties.path.required, true);
  assert.equal(back.properties.limit.type, 'number');
  assert.equal(back.properties.limit.required, undefined);
  assert.equal(back.properties.tags.items.type, 'string');
});
test('propertiesToJsonSchema 对非对象输入返回空结构', () => {
  assert.deepEqual(propertiesToJsonSchema(null), { properties: {}, required: [] });
  assert.deepEqual(propertiesToJsonSchema([1, 2]), { properties: {}, required: [] });
});

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
if (failed > 0) process.exitCode = 1;
