const MAX_MCP_SCHEMA_CHARACTERS = 131072;
const MAX_MCP_ARGUMENT_CHARACTERS = 262144;
const MAX_MCP_VALIDATION_DEPTH = 32;
const MAX_MCP_VALIDATION_NODES = 8192;
const MAX_MCP_VALIDATION_STEPS = 20000;
const MAX_MCP_ONE_OF_BRANCHES = 16;
const MAX_MCP_VALIDATION_PATH_CHARACTERS = 240;

const SUPPORTED_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string"
]);

const ANNOTATION_KEYWORDS = new Set([
  "$comment",
  "$id",
  "$schema",
  "default",
  "deprecated",
  "description",
  "examples",
  "format",
  "readOnly",
  "title",
  "writeOnly"
]);

const VALIDATION_KEYWORDS = new Set([
  "additionalProperties",
  "enum",
  "items",
  "minItems",
  "oneOf",
  "properties",
  "required",
  "type"
]);

function validateMcpToolArguments(argumentsValue, inputSchema) {
  const schemaLimits = inspectJsonValue(inputSchema, MAX_MCP_SCHEMA_CHARACTERS);
  if (!schemaLimits.ok) {
    return unsupportedSchemaFailure("$", "schema", schemaLimits.reason);
  }
  const argumentLimits = inspectJsonValue(argumentsValue, MAX_MCP_ARGUMENT_CHARACTERS);
  if (!argumentLimits.ok) {
    return argumentFailure("$", "limits", "bounded JSON object", argumentLimits.actualType);
  }
  if (!isPlainObject(inputSchema) || inputSchema.type !== "object") {
    return unsupportedSchemaFailure("$", "type", "root schema must declare type object");
  }

  const schemaBudget = { steps: 0 };
  const schemaFailure = validateSupportedSchema(inputSchema, "$", schemaBudget, 0, true);
  if (schemaFailure) {
    return schemaFailure;
  }
  if (!isPlainObject(argumentsValue)) {
    return argumentFailure("$", "type", "object", getJsonType(argumentsValue));
  }

  const valueFailure = validateValue(argumentsValue, inputSchema, "$", { steps: 0 }, 0);
  return valueFailure ?? { ok: true };
}

function validateSupportedSchema(schema, schemaPath, budget, depth, root = false) {
  if (!consumeBudget(budget, depth)) {
    return unsupportedSchemaFailure(schemaPath, "limits", "schema validation limits exceeded");
  }
  if (!isPlainObject(schema)) {
    return unsupportedSchemaFailure(schemaPath, "schema", "schema node must be an object");
  }

  for (const keyword of Object.keys(schema)) {
    if (!ANNOTATION_KEYWORDS.has(keyword) && !VALIDATION_KEYWORDS.has(keyword)) {
      return unsupportedSchemaFailure(appendSchemaPath(schemaPath, keyword), keyword, "unsupported schema keyword");
    }
  }

  if (root && schema.type !== "object") {
    return unsupportedSchemaFailure(appendSchemaPath(schemaPath, "type"), "type", "root schema must declare type object");
  }
  if (schema.type !== undefined && (typeof schema.type !== "string" || !SUPPORTED_TYPES.has(schema.type))) {
    return unsupportedSchemaFailure(appendSchemaPath(schemaPath, "type"), "type", "type must be one supported JSON type");
  }
  if (schema.required !== undefined && (
    !Array.isArray(schema.required) ||
    schema.required.some((key) => typeof key !== "string") ||
    new Set(schema.required).size !== schema.required.length
  )) {
    return unsupportedSchemaFailure(appendSchemaPath(schemaPath, "required"), "required", "required must contain unique strings");
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    return unsupportedSchemaFailure(appendSchemaPath(schemaPath, "enum"), "enum", "enum must be a non-empty array");
  }
  if (Array.isArray(schema.enum) && hasDuplicateJsonValues(schema.enum)) {
    return unsupportedSchemaFailure(appendSchemaPath(schemaPath, "enum"), "enum", "enum values must be unique JSON values");
  }
  if (schema.properties !== undefined && !isPlainObject(schema.properties)) {
    return unsupportedSchemaFailure(appendSchemaPath(schemaPath, "properties"), "properties", "properties must be an object");
  }
  if (schema.items !== undefined && !isPlainObject(schema.items)) {
    return unsupportedSchemaFailure(appendSchemaPath(schemaPath, "items"), "items", "items must contain one schema object");
  }
  if (schema.minItems !== undefined && (!Number.isInteger(schema.minItems) || schema.minItems < 0)) {
    return unsupportedSchemaFailure(
      appendSchemaPath(schemaPath, "minItems"),
      "minItems",
      "minItems must be a non-negative integer"
    );
  }
  if (schema.additionalProperties !== undefined && (
    typeof schema.additionalProperties !== "boolean" && !isPlainObject(schema.additionalProperties)
  )) {
    return unsupportedSchemaFailure(
      appendSchemaPath(schemaPath, "additionalProperties"),
      "additionalProperties",
      "additionalProperties must be boolean or a schema object"
    );
  }
  if (schema.oneOf !== undefined && (
    !Array.isArray(schema.oneOf) ||
    schema.oneOf.length === 0 ||
    schema.oneOf.length > MAX_MCP_ONE_OF_BRANCHES
  )) {
    return unsupportedSchemaFailure(
      appendSchemaPath(schemaPath, "oneOf"),
      "oneOf",
      `oneOf must contain 1 to ${MAX_MCP_ONE_OF_BRANCHES} schema objects`
    );
  }

  for (const [propertyName, childSchema] of Object.entries(schema.properties ?? {})) {
    const failure = validateSupportedSchema(
      childSchema,
      appendSchemaPath(appendSchemaPath(schemaPath, "properties"), propertyName),
      budget,
      depth + 1
    );
    if (failure) return failure;
  }
  if (schema.items !== undefined) {
    const failure = validateSupportedSchema(
      schema.items,
      appendSchemaPath(schemaPath, "items"),
      budget,
      depth + 1
    );
    if (failure) return failure;
  }
  if (isPlainObject(schema.additionalProperties)) {
    const failure = validateSupportedSchema(
      schema.additionalProperties,
      appendSchemaPath(schemaPath, "additionalProperties"),
      budget,
      depth + 1
    );
    if (failure) return failure;
  }
  for (let index = 0; index < (schema.oneOf?.length ?? 0); index += 1) {
    const failure = validateSupportedSchema(
      schema.oneOf[index],
      `${appendSchemaPath(schemaPath, "oneOf")}[${index}]`,
      budget,
      depth + 1
    );
    if (failure) return failure;
  }

  return null;
}

function validateValue(value, schema, path, budget, depth) {
  if (!consumeBudget(budget, depth)) {
    return argumentFailure(path, "limits", "value within validation limits", getJsonType(value));
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonValuesEqual(candidate, value))) {
    return argumentFailure(path, "enum", "one allowed enum value", getJsonType(value));
  }
  if (Array.isArray(schema.oneOf)) {
    let matches = 0;
    for (const candidate of schema.oneOf) {
      if (!validateValue(value, candidate, path, budget, depth + 1)) {
        matches += 1;
      }
    }
    if (budget.exceeded === true) {
      return argumentFailure(path, "limits", "value within validation limits", getJsonType(value));
    }
    if (matches !== 1) {
      return argumentFailure(path, "oneOf", "exactly one allowed schema", getJsonType(value));
    }
  }
  if (typeof schema.type === "string" && !matchesJsonType(value, schema.type)) {
    return argumentFailure(path, "type", schema.type, getJsonType(value));
  }

  if (isPlainObject(value)) {
    for (const required of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) {
        return argumentFailure(appendArgumentPath(path, required), "required", "present", "missing");
      }
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const [key, child] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        const failure = validateValue(child, properties[key], appendArgumentPath(path, key), budget, depth + 1);
        if (failure) return failure;
        continue;
      }
      if (schema.additionalProperties === false) {
        return argumentFailure(appendArgumentPath(path, key), "additionalProperties", "no additional property", getJsonType(child));
      }
      if (isPlainObject(schema.additionalProperties)) {
        const failure = validateValue(
          child,
          schema.additionalProperties,
          appendArgumentPath(path, key),
          budget,
          depth + 1
        );
        if (failure) return failure;
      }
    }
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      return argumentFailure(path, "minItems", `at least ${schema.minItems} item(s)`, "array");
    }
    if (isPlainObject(schema.items)) {
      for (let index = 0; index < value.length; index += 1) {
        const failure = validateValue(value[index], schema.items, `${path}[${index}]`, budget, depth + 1);
        if (failure) return failure;
      }
    }
  }

  return null;
}

function inspectJsonValue(value, maximumCharacters) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { ok: false, reason: "value is not serializable JSON", actualType: getJsonType(value) };
  }
  if (typeof serialized !== "string") {
    return { ok: false, reason: "value is not JSON", actualType: getJsonType(value) };
  }
  if (serialized.length > maximumCharacters) {
    return { ok: false, reason: "value exceeds the character limit", actualType: getJsonType(value) };
  }

  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > MAX_MCP_VALIDATION_NODES || current.depth > MAX_MCP_VALIDATION_DEPTH) {
      return { ok: false, reason: "value exceeds the structural limit", actualType: getJsonType(value) };
    }
    if (typeof current.value === "number" && !Number.isFinite(current.value)) {
      return { ok: false, reason: "value contains a non-finite number", actualType: "number" };
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
    } else if (isPlainObject(current.value)) {
      for (const child of Object.values(current.value)) stack.push({ value: child, depth: current.depth + 1 });
    } else if (
      current.value !== null &&
      !["boolean", "number", "string"].includes(typeof current.value)
    ) {
      return { ok: false, reason: "value contains a non-JSON type", actualType: getJsonType(current.value) };
    }
  }
  return { ok: true };
}

function consumeBudget(budget, depth) {
  budget.steps += 1;
  const allowed = budget.steps <= MAX_MCP_VALIDATION_STEPS && depth <= MAX_MCP_VALIDATION_DEPTH;
  if (!allowed) budget.exceeded = true;
  return allowed;
}

function matchesJsonType(value, expectedType) {
  if (expectedType === "null") return value === null;
  if (expectedType === "array") return Array.isArray(value);
  if (expectedType === "object") return isPlainObject(value);
  if (expectedType === "integer") return Number.isInteger(value);
  if (expectedType === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === expectedType;
}

function getJsonType(value) {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (isPlainObject(value)) return "object";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  if (typeof value === "number") return "number";
  return typeof value;
}

function hasDuplicateJsonValues(values) {
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      if (jsonValuesEqual(values[left], values[right])) return true;
    }
  }
  return false;
}

function jsonValuesEqual(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => jsonValuesEqual(item, right[index]));
  }
  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => (
        key === rightKeys[index] && jsonValuesEqual(left[key], right[key])
      ));
  }
  return false;
}

function appendArgumentPath(path, key) {
  const suffix = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `.${key}`
    : `[${JSON.stringify(key)}]`;
  return boundPath(`${path}${suffix}`);
}

function appendSchemaPath(path, key) {
  return appendArgumentPath(path, key);
}

function boundPath(path) {
  const text = String(path ?? "$");
  if (text.length <= MAX_MCP_VALIDATION_PATH_CHARACTERS) return text;
  return `${text.slice(0, MAX_MCP_VALIDATION_PATH_CHARACTERS - 3)}...`;
}

function argumentFailure(path, keyword, expected, actual) {
  return {
    ok: false,
    error: {
      code: "invalid_arguments",
      path: boundPath(path),
      keyword,
      expected,
      actual
    }
  };
}

function unsupportedSchemaFailure(schemaPath, keyword, expected) {
  return {
    ok: false,
    error: {
      code: "unsupported_input_schema",
      schemaPath: boundPath(schemaPath),
      keyword,
      expected,
      actual: "unsupported schema"
    }
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  validateMcpToolArguments
};
