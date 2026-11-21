/**
 * JSON Schema 互转。
 *
 * 两个方向都要用：
 *  - **出**：DSH 的 `ToolDefinition.parameters` 是 Schemastery 风格的
 *    `ParameterSchemaSpec`，要换成标准 JSON Schema 才能发给手机。
 *  - **入**：手机侧工具带来的是标准 JSON Schema，要换成 DSH 能接受的
 *    `ParameterSchemaSpec`。
 *
 * 纯逻辑，不 import 宿主包，可脱离 DSH 测试。
 *
 * @module dsh-mobile-bridge/schema
 */

/** Schemastery 支持的标量类型。 */
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null']);

/** 触发「放弃结构化转换、退回原始 JSON Schema」的复杂关键字。 */
const COMPLEX_KEYWORDS = ['$ref', 'allOf', 'anyOf', 'not', 'if', 'then', 'else', 'patternProperties'];

/**
 * 判断一个值是否是普通对象（非数组、非 null）。
 *
 * @param {unknown} value - 待判定值。
 * @returns {boolean}
 */
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 把 DSH 的 `ParameterSchemaSpec` 递归投影成标准 JSON Schema。
 *
 * DSH 的 spec 用 `required: true` 逐字段标注必填，而 JSON Schema 要求
 * 必填项集中到父级的 `required: string[]`。这个函数负责那次搬移 ——
 * 一旦漏做，模型侧就会把「必填参数」当可选，调用必然失败。
 *
 * @param {unknown} spec - 单个字段的 spec（含 `type` / `required` / `description` / `items` / `properties`）。
 * @returns {object} 标准 JSON Schema 片段。
 */
export function specToJsonSchema(spec) {
  if (!isPlainObject(spec)) return {};

  // 已经是 JSON Schema（例如 `type: 'json'` 的直塞、或 oneOf 分支）时原样返回。
  const rawType = spec.type;
  /** @type {Record<string, unknown>} */
  const out = {};

  if (typeof rawType === 'string' && SCALAR_TYPES.has(rawType)) {
    out.type = rawType;
  } else if (rawType === 'array') {
    out.type = 'array';
    out.items = isPlainObject(spec.items) ? specToJsonSchema(spec.items) : {};
  } else if (rawType === 'object') {
    out.type = 'object';
    const projected = propertiesToJsonSchema(spec.properties);
    if (Object.keys(projected.properties).length > 0) {
      out.properties = projected.properties;
      if (projected.required.length > 0) out.required = projected.required;
    }
  } else if (rawType === 'json') {
    // `json` 是 Schemastery 里「任意 JSON」的写法；JSON Schema 用空 schema 表达。
    return {};
  } else if (rawType === 'oneOf' && Array.isArray(spec.oneOf)) {
    out.oneOf = spec.oneOf.map((branch) => specToJsonSchema(branch));
  } else if (isPlainObject(rawType)) {
    // 形如 `type: { type: 'string', enum: [...] }` 的包裹写法
    return specToJsonSchema(rawType);
  } else if (rawType === undefined) {
    // 无类型声明：可能是纯 `json` 容器
    return {};
  }

  if (Array.isArray(spec.enum)) out.enum = [...spec.enum];
  if (typeof spec.description === 'string' && spec.description !== '') {
    out.description = spec.description;
  }
  if (isPlainObject(spec.default)) out.default = spec.default;
  else if (spec.default !== undefined && !isPlainObject(spec.default)) out.default = spec.default;

  if (typeof spec.minimum === 'number') out.minimum = spec.minimum;
  if (typeof spec.maximum === 'number') out.maximum = spec.maximum;
  if (typeof spec.minLength === 'number') out.minLength = spec.minLength;
  if (typeof spec.maxLength === 'number') out.maxLength = spec.maxLength;
  if (typeof spec.pattern === 'string') out.pattern = spec.pattern;
  if (spec.additionalProperties !== undefined) out.additionalProperties = spec.additionalProperties;

  return out;
}

/**
 * 把一组字段 spec 转成 JSON Schema 的 `{ properties, required }` 对。
 *
 * @param {unknown} properties - 字段名到 spec 的映射。
 * @returns {{properties: Record<string, object>, required: string[]}}
 */
export function propertiesToJsonSchema(properties) {
  /** @type {Record<string, object>} */
  const out = {};
  /** @type {string[]} */
  const required = [];
  if (!isPlainObject(properties)) return { properties: out, required };

  for (const [key, spec] of Object.entries(properties)) {
    const projected = specToJsonSchema(spec);
    // `required` 是父级语义，不能留在子 schema 里。
    if (isPlainObject(spec) && spec.required === true) required.push(key);
    out[key] = projected;
  }
  return { properties: out, required };
}

/**
 * 把 DSH 的 `ToolDefinition.parameters`（整个 spec 对象）转成可直接发出去的 JSON Schema。
 *
 * @param {unknown} parameters - `ToolDefinition.parameters`。
 * @returns {{type: 'object', properties: Record<string, object>, required?: string[], additionalProperties?: boolean}}
 */
export function toolParametersToJsonSchema(parameters) {
  const { properties, required } = propertiesToJsonSchema(parameters);
  /** @type {{type: 'object', properties: Record<string, object>, required?: string[], additionalProperties?: boolean}} */
  const schema = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

/**
 * 把一份 `ToolSchema`（`{ name, description, parameters }`）转成 wire 上的工具描述。
 *
 * **关键（踩过坑）**：`ctx.tools.schemas()` 返回的 `parameters` **已经是标准 JSON Schema**
 * （形如 `{type:'object', properties:{...}, required:[...]}`）—— 这是 `defineTool`
 * 把字段映射编译后的结果。所以它应当**原样透传**。
 *
 * 早期这里误调了 `toolParametersToJsonSchema()`，把整个 schema 当成「字段映射」
 * 再包一层，结果 `properties` 变成 `{type:{}, properties:{}, required:{}}` ——
 * 手机看到的是三个假字段，于是给工具传错参数（例如给 `remote_list_hosts`
 * 传 `{query, scope}`，其实它要 `{}`）。这是一个**只有真机调用才暴露**的 bug：
 * 工具能列出来、连接也通，但所有带参工具都调用失败。
 *
 * @param {{name: string, description?: string, parameters?: unknown}} schema - 来自 `ctx.tools.schemas()` 的一项。
 * @returns {{name: string, description: string, parameters: object}}
 */
export function toolSchemaToWire(schema) {
  const raw = schema?.parameters;
  // 已经是 object 根的 JSON Schema → 原样透传。
  const parameters = (isPlainObject(raw) && raw.type === 'object' && isPlainObject(raw.properties))
    ? raw
    : toolParametersToJsonSchema(raw);
  return {
    name: String(schema?.name ?? ''),
    description: typeof schema?.description === 'string' ? schema.description : '',
    parameters,
  };
}

/**
 * 判断一份 JSON Schema 是否含有 Schemastery 表达不了的复杂关键字。
 *
 * 含复合关键字时，退回「整份 schema 塞进 `type: 'json'`」是唯一无损做法 ——
 * 强行降级会悄悄放宽或收紧参数约束，比不做转换更危险。
 *
 * @param {unknown} schema - 待检查的 JSON Schema。
 * @returns {boolean}
 */
export function hasComplexJsonSchemaKeywords(schema) {
  if (!isPlainObject(schema)) return false;
  for (const keyword of COMPLEX_KEYWORDS) {
    if (schema[keyword] !== undefined) return true;
  }
  // `oneOf` 且只有一个分支才可能无损，多于一分支保守退回。
  if (Array.isArray(schema.oneOf) && schema.oneOf.length !== 1) return true;
  if (isPlainObject(schema.properties)) {
    for (const value of Object.values(schema.properties)) {
      if (hasComplexJsonSchemaKeywords(value)) return true;
    }
  }
  if (isPlainObject(schema.items) && hasComplexJsonSchemaKeywords(schema.items)) return true;
  if (Array.isArray(schema.oneOf) && schema.oneOf.some((b) => hasComplexJsonSchemaKeywords(b))) return true;
  return false;
}

/**
 * 把标准 JSON Schema 转成 DSH 的 `ParameterSchemaSpec`。
 *
 * 这是入方向（手机工具 → DSH）。转换是**有损**的：DSH 的 spec 只支持
 * 标量/数组/对象/oneOf，遇到 `$ref`、`allOf`、`not` 等复合关键字时，
 * 调用方应先用 {@link hasComplexJsonSchemaKeywords} 判断并退回整份 JSON
 * Schema 直塞（`{ type: 'json' }`）。
 *
 * @param {unknown} schema - 标准 JSON Schema。
 * @returns {object} `ParameterSchemaSpec` 片段。
 */
export function jsonSchemaToSpec(schema) {
  if (!isPlainObject(schema)) return {};
  /** @type {Record<string, unknown>} */
  const out = {};

  const type = schema.type;
  if (Array.isArray(type)) {
    // 多类型联合在 Schemastery 里没有等价物，退回任意 JSON。
    return {};
  }
  if (typeof type === 'string' && SCALAR_TYPES.has(type)) {
    out.type = type;
  } else if (type === 'array') {
    out.type = 'array';
    out.items = isPlainObject(schema.items) ? jsonSchemaToSpec(schema.items) : {};
  } else if (type === 'object') {
    out.type = 'object';
    out.properties = jsonSchemaObjectToSpec(schema);
  } else if (Array.isArray(schema.oneOf) && schema.oneOf.length === 1) {
    return jsonSchemaToSpec(schema.oneOf[0]);
  } else {
    // 没有 type，或 type 是复杂形式：退化成任意 JSON。
    return {};
  }

  if (Array.isArray(schema.enum)) out.enum = [...schema.enum];
  if (typeof schema.description === 'string' && schema.description !== '') {
    out.description = schema.description;
  }
  if (schema.default !== undefined) out.default = schema.default;
  if (typeof schema.minimum === 'number') out.minimum = schema.minimum;
  if (typeof schema.maximum === 'number') out.maximum = schema.maximum;
  if (typeof schema.minLength === 'number') out.minLength = schema.minLength;
  if (typeof schema.maxLength === 'number') out.maxLength = schema.maxLength;
  if (typeof schema.pattern === 'string') out.pattern = schema.pattern;
  if (schema.additionalProperties !== undefined) out.additionalProperties = schema.additionalProperties;

  return out;
}

/**
 * 把一个 `{ properties, required }` 形式的 JSON Schema 对象字段集转成 spec 的 `properties`。
 *
 * 注意这里是 JSON Schema → spec 的 `required: true` 反搬移。
 *
 * @param {unknown} schema - `type: 'object'` 的 JSON Schema。
 * @returns {Record<string, object>}
 */
export function jsonSchemaObjectToSpec(schema) {
  /** @type {Record<string, object>} */
  const out = {};
  if (!isPlainObject(schema) || !isPlainObject(schema.properties)) return out;
  const required = Array.isArray(schema.required) ? new Set(schema.required) : new Set();
  for (const [key, value] of Object.entries(schema.properties)) {
    const spec = jsonSchemaToSpec(value);
    if (required.has(key)) spec.required = true;
    out[key] = spec;
  }
  return out;
}

/**
 * 把 wire 上的工具描述转成 DSH `defineTool()` 能吃的 `parameters`。
 *
 * **关键语义**（实测于真实 `defineTool`，见 `dsh-tools/src/schema.ts:450`）：
 * `parameters` 是**逐字段的映射**（`ParameterSchemaSpec`），也就是
 * `{ 字段名: spec }`，而**不是** `{ type: 'object', properties: {...} }`
 * 这种包裹结构。传包裹结构会被 `compilePropertyMap` 当成「有个叫
 * `type` 的字段」，直接报 `parameters.type must be a value schema object`
 * 并让整个工具注册失败。
 *
 * 因此这里返回的 `spec` 直接就是属性映射，调用方拿到后原样交给 defineTool。
 *
 * 优先做结构化转换；遇到表达不了的复合 schema 时整份直塞成空 spec，
 * 并在 `lossy` 里标记，让上层决定是否提示用户。
 *
 * @param {unknown} parameters - wire 上收到的 JSON Schema（`{type:'object', properties}`）。
 * @returns {{spec: Record<string, object>, lossy: boolean}}
 */
export function wireParametersToSpec(parameters) {
  if (!isPlainObject(parameters)) return { spec: {}, lossy: false };
  const properties = parameters.properties;
  if (!isPlainObject(properties) || Object.keys(properties).length === 0) {
    return { spec: {}, lossy: false };
  }
  if (hasComplexJsonSchemaKeywords(parameters)) {
    return { spec: {}, lossy: true };
  }
  // 直接返回属性映射本身，不带 `type`/`properties` 包裹。
  return {
    spec: jsonSchemaObjectToSpec(parameters),
    lossy: false,
  };
}
