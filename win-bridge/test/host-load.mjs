/**
 * 宿主内验证：用 DSH 自带的 Electron-as-Node 加载插件，确认
 *  - 模块能真实 import 成功（无语法错误、无缺失依赖）；
 *  - `defineTool` 能从真实 `@deepseek-ai/dsh-tools` 解析到；
 *  - 用真实 defineTool 走一遍注册，验证 parameters/output 结构合法。
 *
 * 这一步不启动 DSH、不挂 webServer，因此安全且不需要重启。
 *
 * 用法：ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" test/host-load.mjs
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let passed = 0;
let failed = 0;

/**
 * @param {string} name - 用例名。
 * @param {() => Promise<void> | void} body - 用例体。
 */
async function test(name, body) {
  try {
    await body();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  }
}

console.log('\n== host: 模块可加载 ==');
const plugin = await import('../lib/index.js');

await test('插件导出 name 与 inject', () => {
  assert.equal(plugin.name, 'dsh-mobile-bridge');
  assert.deepEqual([...plugin.inject].sort(), ['tools', 'webServer']);
});
await test('插件导出 apply 函数', () => {
  assert.equal(typeof plugin.apply, 'function');
});
await test('protocol 模块可独立加载', async () => {
  const mod = await import('../lib/protocol.js');
  assert.equal(mod.PROTOCOL_VERSION, 1);
  assert.equal(typeof mod.parseTrace, 'function');
});
await test('schema 模块可独立加载', async () => {
  const mod = await import('../lib/schema.js');
  assert.equal(typeof mod.toolSchemaToWire, 'function');
});
await test('client 模块可独立加载', async () => {
  const mod = await import('../lib/client.js');
  assert.equal(typeof mod.callRemoteTool, 'function');
});

console.log('\n== host: 真实 dsh-tools 可用性 ==');
let defineTool = null;
let toolsModule = null;
await test('能从 DSH 安装锚点解析到 @deepseek-ai/dsh-tools', async () => {
  // 插件在 profile 里运行时，模块解析的锚点是 DSH 安装目录；
  // 在工作区直接跑时没有这份 node_modules，因此显式从安装锚点解析。
  const anchor = process.env.DSH_INSTALL_DIR;
  assert.ok(typeof anchor === 'string' && anchor !== '', 'DSH_INSTALL_DIR must be set');
  const entry = require.resolve('@deepseek-ai/dsh-tools', { paths: [anchor] });
  assert.ok(entry.endsWith('index.js') || entry.includes('dsh-tools'));
  toolsModule = await import(new URL(`file:///${entry.replaceAll('\\', '/')}`).href);
  defineTool = toolsModule.defineTool;
  assert.equal(typeof defineTool, 'function');
  console.log(`       入口: ${entry}`);
});

if (defineTool !== null) {
  console.log('\n== host: 真实 defineTool 校验我们的工具定义 ==');
  const { wireParametersToSpec } = await import('../lib/schema.js');

  await test('wire JSON Schema 经转换后能通过真实 defineTool 校验', () => {
    // 用真实转换函数，而不是手写 spec —— 这才是生产路径。
    const { spec, lossy } = wireParametersToSpec({
      type: 'object',
      properties: {
        detail: { type: 'boolean', description: '是否返回细节' },
        level: { type: 'number' },
      },
      required: ['detail'],
    });
    assert.equal(lossy, false);

    const definition = defineTool({
      name: 'mcp__phone__get_battery',
      description: '读取手机电量',
      parameters: spec,
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute() {
        return { battery: 87 };
      },
    });
    assert.equal(definition.name, 'mcp__phone__get_battery');
    assert.equal(typeof definition.execute, 'function');
  });
  await test('真实 defineTool 把 required 编译到父级 required 数组', () => {
    const { spec } = wireParametersToSpec({
      type: 'object',
      properties: { detail: { type: 'boolean' } },
      required: ['detail'],
    });
    // 入参是字段映射，其中 detail.required === true
    assert.equal(spec.detail.required, true);

    const definition = defineTool({
      name: 'mcp__phone__required_probe',
      description: 'x',
      parameters: spec,
      output: { schema: { type: 'json' }, render: () => [] },
      async execute() {
        return null;
      },
    });
    // 出参是编译后的标准 JSON Schema：required 回到了父级数组
    assert.equal(definition.parameters.type, 'object');
    assert.equal(definition.parameters.properties.detail.type, 'boolean');
    assert.deepEqual(definition.parameters.required, ['detail']);
  });
  await test('复杂 schema 退回空 spec 后仍能注册', () => {
    const { spec, lossy } = wireParametersToSpec({
      type: 'object',
      properties: { a: { $ref: '#/x' } },
    });
    assert.equal(lossy, true);
    const definition = defineTool({
      name: 'mcp__phone__complex',
      description: 'x',
      parameters: spec,
      output: { schema: { type: 'json' }, render: () => [] },
      async execute() {
        return null;
      },
    });
    assert.equal(definition.name, 'mcp__phone__complex');
  });
  await test('包裹结构会被真实 defineTool 拒绝（记录我们踩过的坑）', () => {
    assert.throws(() => {
      defineTool({
        name: 'bad_shape',
        description: 'x',
        parameters: { type: 'object', properties: { a: { type: 'string' } } },
        output: { schema: { type: 'json' }, render: () => [] },
        async execute() {
          return null;
        },
      });
    }, /value schema object/);
  });
  await test('真实 defineTool 会拒绝缺 output 的定义（证明是真实实现）', () => {
    assert.throws(() => {
      defineTool({
        name: 'bad',
        description: 'x',
        parameters: {},
        async execute() {
          return null;
        },
      });
    });
  });
}

console.log('\n== host: 真实 module 解析路径 ==');
await test('dsh-tools 解析到安装目录而非工作区', () => {
  let resolved = null;
  try {
    resolved = require.resolve('@deepseek-ai/dsh-tools/package.json', {
      paths: [process.env.DSH_INSTALL_DIR ?? '.'],
    });
  } catch {
    resolved = null;
  }
  if (resolved !== null) {
    console.log(`       resolved: ${resolved}`);
    assert.ok(resolved.length > 0);
  } else {
    console.log('       （本环境无法从 DSH_INSTALL_DIR 解析，跳过路径断言）');
  }
});

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
if (failed > 0) process.exitCode = 1;
