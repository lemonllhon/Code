export type ToolInputSchema = Record<string, unknown>;
type Json = ToolInputSchema;
type AuthWireProtocol = "openai-chat-completions" | "openai-responses" | "anthropic-messages";
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};

const COMPOSITIONS = ["allOf", "anyOf", "oneOf"];
const SCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const SCHEMA_LISTS = ["allOf", "anyOf", "oneOf", "prefixItems"];
const SCHEMA_VALUES = [
  "items",
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "contains",
  "additionalItems",
  "unevaluatedItems",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
];
const MAX_DEPTH = 32;

export class ToolSchemaCompatibilityError extends Error {
  readonly code = "invalid_model_request";
  readonly context = {
    retryable: false,
    reason: "invalid_request",
    retryDisposition: "terminal",
  } as const;
  constructor(message: string) {
    super(`Tool schema: ${message}`);
    this.name = "ToolSchemaCompatibilityError";
  }
}

/** 合并所有备选值；禁止把 discriminated union 的首个分支当成完整契约。 */
export function mergeToolSchemaAlternatives(branches: Json[]): Json {
  const unique = branches.filter(
    (branch, index) =>
      branches.findIndex((other) => JSON.stringify(other) === JSON.stringify(branch)) === index,
  );
  if (unique.length === 1) return unique[0]!;
  const values = unique.flatMap((branch) =>
    Object.hasOwn(branch, "const") ? [branch.const] : list(branch.enum),
  );
  if (
    unique.length > 0 &&
    unique.every(
      (branch) =>
        (Object.hasOwn(branch, "const") || Array.isArray(branch.enum)) &&
        Object.keys(branch).every((key) =>
          ["type", "const", "enum", "title", "description"].includes(key),
        ),
    ) &&
    values.length &&
    values.every(
      (value) =>
        typeof value === typeof values[0] &&
        ["string", "number", "boolean"].includes(typeof value) &&
        (typeof value !== "number" || Number.isFinite(value)),
    )
  ) {
    return {
      type: typeof values[0] === "number" ? "number" : typeof values[0],
      enum: [...new Set(values)],
    };
  }
  return { anyOf: unique };
}

function localRef(root: Json, schema: Json): Json {
  if (typeof schema.$ref !== "string") return schema;
  if (!schema.$ref.startsWith("#/"))
    throw new ToolSchemaCompatibilityError("unsupported or cyclic root reference");
  let value: unknown = root;
  for (const segment of schema.$ref.slice(2).split("/")) {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
      throw new ToolSchemaCompatibilityError("unresolvable root reference");
    value = record(value)[key];
  }
  const { $ref: _ref, ...siblings } = schema;
  return { ...record(value), ...siblings };
}

function assertObjectRoot(schema: Json): void {
  const scalar = (value: unknown) =>
    value === null || typeof value !== "object" || Array.isArray(value);
  if (
    (schema.type !== undefined && schema.type !== "object") ||
    (Object.hasOwn(schema, "const") && scalar(schema.const)) ||
    (Array.isArray(schema.enum) && schema.enum.some(scalar))
  )
    throw new ToolSchemaCompatibilityError("function parameters require an object root");
}

/** 仅投影函数参数根；原工具执行校验保持原 Schema，不增加包装参数或改工具名。 */
export function objectToolSchema(root: Json): Json {
  const fold = (value: Json, depth: number): Json => {
    if (depth > MAX_DEPTH) throw new ToolSchemaCompatibilityError("root reference depth exceeded");
    const schema = localRef(root, value);
    if (schema !== value && typeof schema.$ref === "string") return fold(schema, depth + 1);
    assertObjectRoot(schema);
    if (schema.type === "object" && !COMPOSITIONS.some((key) => Object.hasOwn(schema, key)))
      return schema;
    const props: Json = Object.assign(Object.create(null), record(schema.properties));
    const required = list(schema.required).filter(
      (name): name is string => typeof name === "string",
    );
    for (const branch of list(schema.allOf)) {
      const normalized = fold(record(branch), depth + 1);
      for (const [key, item] of Object.entries(record(normalized.properties)))
        if (!Object.hasOwn(props, key)) props[key] = item;
      required.push(
        ...list(normalized.required).filter((name): name is string => typeof name === "string"),
      );
    }
    const branches = [...list(schema.anyOf), ...list(schema.oneOf)].map((branch) =>
      fold(record(branch), depth + 1),
    );
    const variants = new Map<string, unknown[]>();
    for (const branch of branches) {
      for (const [key, item] of Object.entries(record(branch.properties))) {
        if (Object.hasOwn(props, key)) continue;
        const previous = variants.get(key) ?? [];
        if (!previous.some((existing) => JSON.stringify(existing) === JSON.stringify(item)))
          previous.push(item);
        variants.set(key, previous);
      }
    }
    for (const [key, values] of variants)
      props[key] = mergeToolSchemaAlternatives(values.map(record));
    if (branches.length)
      required.push(
        ...list(branches[0]!.required).filter(
          (name): name is string =>
            typeof name === "string" &&
            branches.every((branch) => list(branch.required).includes(name)),
        ),
      );
    const out: Json = { ...schema, type: "object", properties: { ...props } };
    for (const key of [...COMPOSITIONS, "$ref", "enum", "const", "not"]) delete out[key];
    const names = [...new Set(required)].filter((name) => Object.hasOwn(props, name));
    if (names.length) out.required = names;
    else delete out.required;
    return out;
  };
  return fold(root, 0);
}

/** Cline 的语法编译器不支持 oneOf；只遍历 Schema 位置，不能改参数名或普通 JSON 数据。 */
function oneOfAsAnyOf(schema: Json, depth = 0): Json {
  if (depth > MAX_DEPTH) return schema;
  const out = { ...schema };
  const visit = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? oneOfAsAnyOf(record(value), depth + 1)
      : value;
  for (const key of SCHEMA_MAPS)
    if (schema[key] && typeof schema[key] === "object")
      out[key] = Object.fromEntries(
        Object.entries(record(schema[key])).map(([name, item]) => [name, visit(item)]),
      );
  for (const key of SCHEMA_LISTS)
    if (Array.isArray(schema[key])) out[key] = list(schema[key]).map(visit);
  for (const key of SCHEMA_VALUES) {
    const value = schema[key];
    if (Array.isArray(value)) out[key] = value.map(visit);
    else if (value && typeof value === "object") out[key] = visit(value);
  }
  if (Array.isArray(out.oneOf)) {
    const converted = out.oneOf;
    delete out.oneOf;
    if (Array.isArray(out.anyOf)) {
      const existing = out.anyOf;
      delete out.anyOf;
      out.allOf = [...list(out.allOf), { anyOf: existing }, { anyOf: converted }];
    } else out.anyOf = converted;
  }
  return out;
}

export function prepareToolSchemas(
  body: Json,
  protocol: AuthWireProtocol,
  options: { objectRoots?: boolean; oneOfAsAnyOf?: boolean },
): Json {
  if (!Array.isArray(body.tools)) return body;
  const tools = list(body.tools).map((raw) => {
    const tool = record(raw);
    if (protocol === "openai-responses" && tool.type === "namespace")
      return prepareToolSchemas(tool, protocol, options);
    const fn = protocol === "openai-chat-completions" ? record(tool.function) : tool;
    const key = protocol === "anthropic-messages" ? "input_schema" : "parameters";
    if (!fn[key] || typeof fn[key] !== "object") return tool;
    let schema = record(fn[key]);
    if (options.objectRoots) schema = objectToolSchema(schema);
    if (options.oneOfAsAnyOf) schema = oneOfAsAnyOf(schema);
    const normalized = { ...fn, [key]: schema };
    return protocol === "openai-chat-completions" ? { ...tool, function: normalized } : normalized;
  });
  return { ...body, tools };
}
