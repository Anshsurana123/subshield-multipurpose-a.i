import { McpError, type JsonSchema } from "./types.ts";

export interface JsonSchemaValidationIssue {
  path: string;
  keyword: string;
  message: string;
}

const ANNOTATION_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$anchor",
  "$comment",
  "title",
  "description",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
  "examples",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
]);

const SUPPORTED_KEYWORDS = new Set([
  "$ref",
  "$defs",
  "definitions",
  "type",
  "enum",
  "const",
  "multipleOf",
  "maximum",
  "exclusiveMaximum",
  "minimum",
  "exclusiveMinimum",
  "maxLength",
  "minLength",
  "pattern",
  "format",
  "maxItems",
  "minItems",
  "uniqueItems",
  "maxContains",
  "minContains",
  "maxProperties",
  "minProperties",
  "required",
  "dependentRequired",
  "properties",
  "patternProperties",
  "additionalProperties",
  "propertyNames",
  "items",
  "prefixItems",
  "contains",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
]);

const MAX_DEPTH = 64;
const MAX_ISSUES = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === "boolean" || isRecord(value);
}

function escapePathSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function childPath(path: string, segment: string | number): string {
  return `${path}/${escapePathSegment(String(segment))}`;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => jsonEqual(item, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] && jsonEqual(left[key], right[key]),
      )
    );
  }
  return false;
}

function resolveLocalReference(root: JsonSchema, reference: string): JsonSchema {
  if (reference === "#") return root;
  if (!reference.startsWith("#/")) {
    throw new McpError(
      "SCHEMA_UNSUPPORTED",
      "Only local JSON Schema references are supported for MCP arguments.",
    );
  }

  let current: unknown = root;
  for (const encoded of reference.slice(2).split("/")) {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isRecord(current) || !(key in current)) {
      throw new McpError(
        "SCHEMA_UNSUPPORTED",
        "An MCP input schema contains an unresolved local reference.",
      );
    }
    current = current[key];
  }

  if (!isSchema(current)) {
    throw new McpError(
      "SCHEMA_UNSUPPORTED",
      "An MCP input schema reference does not resolve to a schema.",
    );
  }
  return current;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "string":
      return typeof value === "string";
    default:
      throw new McpError(
        "SCHEMA_UNSUPPORTED",
        `Unsupported JSON Schema type ${type}.`,
      );
  }
}

function validateFormat(value: string, format: string): boolean {
  switch (format) {
    case "uuid":
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        value,
      );
    case "email":
    case "idn-email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
    case "uri":
    case "uri-reference":
    case "url":
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    case "date-time":
      return (
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
          value,
        ) && !Number.isNaN(Date.parse(value))
      );
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/u.test(value);
    case "time":
      return /^\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
        value,
      );
    default:
      // JSON Schema formats are annotations unless a format assertion
      // vocabulary is explicitly in use. Unknown formats remain annotations.
      return true;
  }
}

interface ValidationContext {
  root: JsonSchema;
  issues: JsonSchemaValidationIssue[];
}

function addIssue(
  context: ValidationContext,
  path: string,
  keyword: string,
  message: string,
): void {
  if (context.issues.length < MAX_ISSUES) {
    context.issues.push({ path, keyword, message });
  }
}

function validateSubschemaList(
  value: unknown,
  keyword: string,
): JsonSchema[] {
  if (!Array.isArray(value) || !value.every(isSchema)) {
    throw new McpError(
      "SCHEMA_UNSUPPORTED",
      `MCP input schema keyword ${keyword} must contain schemas.`,
    );
  }
  return value;
}

function validationCount(
  value: unknown,
  schema: JsonSchema,
  context: ValidationContext,
  path: string,
  depth: number,
): number {
  const temporary: ValidationContext = { root: context.root, issues: [] };
  validateNode(value, schema, temporary, path, depth + 1);
  return temporary.issues.length;
}

function validateNode(
  value: unknown,
  schema: JsonSchema,
  context: ValidationContext,
  path: string,
  depth: number,
): void {
  if (depth > MAX_DEPTH) {
    throw new McpError(
      "SCHEMA_UNSUPPORTED",
      "MCP input schema validation exceeded the maximum nesting depth.",
    );
  }

  if (schema === true) return;
  if (schema === false) {
    addIssue(context, path, "falseSchema", "Value is rejected by the schema.");
    return;
  }

  for (const keyword of Object.keys(schema)) {
    if (
      !SUPPORTED_KEYWORDS.has(keyword) &&
      !ANNOTATION_KEYWORDS.has(keyword) &&
      !keyword.startsWith("x-")
    ) {
      throw new McpError(
        "SCHEMA_UNSUPPORTED",
        `Unsupported MCP input schema keyword ${keyword}.`,
      );
    }
  }

  if (schema.$ref !== undefined) {
    if (typeof schema.$ref !== "string") {
      throw new McpError(
        "SCHEMA_UNSUPPORTED",
        "MCP input schema $ref must be a string.",
      );
    }
    validateNode(
      value,
      resolveLocalReference(context.root, schema.$ref),
      context,
      path,
      depth + 1,
    );
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (
      types.length === 0 ||
      !types.every((type) => typeof type === "string")
    ) {
      throw new McpError(
        "SCHEMA_UNSUPPORTED",
        "MCP input schema type must be a string or non-empty string array.",
      );
    }
    if (!(types as string[]).some((type) => matchesType(value, type))) {
      addIssue(context, path, "type", "Value has the wrong JSON type.");
      return;
    }
  }

  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      throw new McpError(
        "SCHEMA_UNSUPPORTED",
        "MCP input schema enum must be a non-empty array.",
      );
    }
    if (!schema.enum.some((candidate) => jsonEqual(value, candidate))) {
      addIssue(context, path, "enum", "Value is not in the allowed set.");
    }
  }

  if ("const" in schema && !jsonEqual(value, schema.const)) {
    addIssue(context, path, "const", "Value does not match the required constant.");
  }

  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    if (schema[keyword] === undefined) continue;
    const schemas = validateSubschemaList(schema[keyword], keyword);
    const matches = schemas.filter(
      (candidate) =>
        validationCount(value, candidate, context, path, depth) === 0,
    ).length;

    if (keyword === "allOf") {
      for (const candidate of schemas) {
        validateNode(value, candidate, context, path, depth + 1);
      }
    } else if (keyword === "anyOf" && matches === 0) {
      addIssue(context, path, keyword, "Value matches no allowed schema.");
    } else if (keyword === "oneOf" && matches !== 1) {
      addIssue(context, path, keyword, "Value must match exactly one schema.");
    }
  }

  if (schema.not !== undefined) {
    if (!isSchema(schema.not)) {
      throw new McpError(
        "SCHEMA_UNSUPPORTED",
        "MCP input schema not must contain a schema.",
      );
    }
    if (validationCount(value, schema.not, context, path, depth) === 0) {
      addIssue(context, path, "not", "Value matches a forbidden schema.");
    }
  }

  if (schema.if !== undefined) {
    if (!isSchema(schema.if)) {
      throw new McpError(
        "SCHEMA_UNSUPPORTED",
        "MCP input schema if must contain a schema.",
      );
    }
    const conditionMatches =
      validationCount(value, schema.if, context, path, depth) === 0;
    const branch = conditionMatches ? schema.then : schema.else;
    if (branch !== undefined) {
      if (!isSchema(branch)) {
        throw new McpError(
          "SCHEMA_UNSUPPORTED",
          "MCP input schema conditional branches must be schemas.",
        );
      }
      validateNode(value, branch, context, path, depth + 1);
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const numericKeywords = [
      "maximum",
      "exclusiveMaximum",
      "minimum",
      "exclusiveMinimum",
      "multipleOf",
    ] as const;
    for (const keyword of numericKeywords) {
      if (
        schema[keyword] !== undefined &&
        (typeof schema[keyword] !== "number" ||
          !Number.isFinite(schema[keyword]))
      ) {
        throw new McpError(
          "SCHEMA_UNSUPPORTED",
          `MCP input schema ${keyword} must be a finite number.`,
        );
      }
    }

    if (typeof schema.maximum === "number" && value > schema.maximum) {
      addIssue(context, path, "maximum", "Number exceeds its maximum.");
    }
    if (
      typeof schema.exclusiveMaximum === "number" &&
      value >= schema.exclusiveMaximum
    ) {
      addIssue(
        context,
        path,
        "exclusiveMaximum",
        "Number exceeds its exclusive maximum.",
      );
    }
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      addIssue(context, path, "minimum", "Number is below its minimum.");
    }
    if (
      typeof schema.exclusiveMinimum === "number" &&
      value <= schema.exclusiveMinimum
    ) {
      addIssue(
        context,
        path,
        "exclusiveMinimum",
        "Number is below its exclusive minimum.",
      );
    }
    if (typeof schema.multipleOf === "number") {
      if (schema.multipleOf <= 0) {
        throw new McpError(
          "SCHEMA_UNSUPPORTED",
          "MCP input schema multipleOf must be greater than zero.",
        );
      }
      const quotient = value / schema.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-10) {
        addIssue(context, path, "multipleOf", "Number is not an allowed multiple.");
      }
    }
  }

  if (typeof value === "string") {
    for (const keyword of ["minLength", "maxLength"] as const) {
      if (
        schema[keyword] !== undefined &&
        (!Number.isSafeInteger(schema[keyword]) ||
          (schema[keyword] as number) < 0)
      ) {
        throw new McpError(
          "SCHEMA_UNSUPPORTED",
          `MCP input schema ${keyword} must be a non-negative integer.`,
        );
      }
    }
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength) {
      addIssue(context, path, "minLength", "String is shorter than allowed.");
    }
    if (typeof schema.maxLength === "number" && length > schema.maxLength) {
      addIssue(context, path, "maxLength", "String is longer than allowed.");
    }
    if (schema.pattern !== undefined) {
      if (typeof schema.pattern !== "string" || schema.pattern.length > 1_024) {
        throw new McpError(
          "SCHEMA_UNSUPPORTED",
          "MCP input schema pattern must be a bounded string.",
        );
      }
      let pattern: RegExp;
      try {
        pattern = new RegExp(schema.pattern, "u");
      } catch (cause) {
        throw new McpError(
          "SCHEMA_UNSUPPORTED",
          "MCP input schema contains an invalid pattern.",
          { cause },
        );
      }
      if (!pattern.test(value)) {
        addIssue(context, path, "pattern", "String does not match its pattern.");
      }
    }
    if (schema.format !== undefined) {
      if (typeof schema.format !== "string") {
        throw new McpError(
          "SCHEMA_UNSUPPORTED",
          "MCP input schema format must be a string.",
        );
      }
      if (!validateFormat(value, schema.format)) {
        addIssue(context, path, "format", "String has an invalid format.");
      }
    }
  }

  if (Array.isArray(value)) {
    for (const keyword of ["minItems", "maxItems"] as const) {
      if (
        schema[keyword] !== undefined &&
        (!Number.isSafeInteger(schema[keyword]) ||
          (schema[keyword] as number) < 0)
      ) {
        throw new McpError(
          "SCHEMA_UNSUPPORTED",
          `MCP input schema ${keyword} must be a non-negative integer.`,
        );
      }
    }
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      addIssue(context, path, "minItems", "Array has too few items.");
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      addIssue(context, path, "maxItems", "Array has too many items.");
    }
    if (schema.uniqueItems === true) {
      const duplicate = value.some((item, index) =>
        value.slice(0, index).some((prior) => jsonEqual(item, prior)),
      );
      if (duplicate) {
        addIssue(context, path, "uniqueItems", "Array items must be unique.");
      }
    } else if (
      schema.uniqueItems !== undefined &&
      schema.uniqueItems !== false
    ) {
      throw new McpError(
        "SCHEMA_UNSUPPORTED",
        "MCP input schema uniqueItems must be boolean.",
      );
    }

    let prefixCount = 0;
    if (schema.prefixItems !== undefined) {
      const prefixItems = validateSubschemaList(schema.prefixItems, "prefixItems");
      prefixCount = prefixItems.length;
      prefixItems.forEach((itemSchema, index) => {
        if (index < value.length) {
          validateNode(
            value[index],
            itemSchema,
            context,
            childPath(path, index),
            depth + 1,
          );
        }
      });
    }

    if (schema.items !== undefined) {
      if (!isSchema(schema.items)) {
        throw new McpError(
          "SCHEMA_UNSUPPORTED",
          "MCP input schema items must contain a schema.",
        );
      }
      for (let index = prefixCount; index < value.length; index += 1) {
        validateNode(
          value[index],
          schema.items,
          context,
          childPath(path, index),
          depth + 1,
        );
      }
    }

    if (schema.contains !== undefined) {
      if (!isSchema(schema.contains)) {
        throw new McpError(
          "SCHEMA_UNSUPPORTED",
          "MCP input schema contains must contain a schema.",
        );
      }
      const matches = value.filter(
        (item, index) =>
          validationCount(
            item,
            schema.contains as JsonSchema,
            context,
            childPath(path, index),
            depth,
          ) === 0,
      ).length;
      const minimum = schema.minContains === undefined ? 1 : schema.minContains;
      const maximum = schema.maxContains;
      if (!Number.isSafeInteger(minimum) || (minimum as number) < 0) {
        throw new McpError(
          "SCHEMA_UNSUPPORTED",
          "MCP input schema minContains must be a non-negative integer.",
        );
      }
      if (
        maximum !== undefined &&
        (!Number.isSafeInteger(maximum) || (maximum as number) < 0)
      ) {
        throw new McpError(
          "SCHEMA_UNSUPPORTED",
          "MCP input schema maxContains must be a non-negative integer.",
        );
      }
      if (matches < (minimum as number)) {
        addIssue(context, path, "minContains", "Array has too few matching items.");
      }
      if (typeof maximum === "number" && matches > maximum) {
        addIssue(context, path, "maxContains", "Array has too many matching items.");
      }
    } else if (
      schema.minContains !== undefined ||
      schema.maxContains !== undefined
    ) {
      throw new McpError(
        "SCHEMA_UNSUPPORTED",
        "MCP input schema contains limits require contains.",
      );
    }
  }

  if (isRecord(value)) {
    const keys = Object.keys(value);
    for (const keyword of ["minProperties", "maxProperties"] as const) {
      if (
        schema[keyword] !== undefined &&
        (!Number.isSafeInteger(schema[keyword]) ||
          (schema[keyword] as number) < 0)
      ) {
        throw new McpError(
          "SCHEMA_UNSUPPORTED",
          `MCP input schema ${keyword} must be a non-negative integer.`,
        );
      }
    }
    if (
      typeof schema.minProperties === "number" &&
      keys.length < schema.minProperties
    ) {
      addIssue(context, path, "minProperties", "Object has too few properties.");
    }
    if (
      typeof schema.maxProperties === "number" &&
      keys.length > schema.maxProperties
    ) {
      addIssue(context, path, "maxProperties", "Object has too many properties.");
    }

    if (schema.required !== undefined) {
      if (
        !Array.isArray(schema.required) ||
        !schema.required.every((key) => typeof key === "string")
      ) {
        throw new McpError(
          "SCHEMA_UNSUPPORTED",
          "MCP input schema required must be a string array.",
        );
      }
      for (const key of schema.required as string[]) {
        if (!(key in value)) {
          addIssue(
            context,
            childPath(path, key),
            "required",
            "Required property is missing.",
          );
        }
      }
    }

    const properties = schema.properties;
    if (properties !== undefined && !isRecord(properties)) {
      throw new McpError(
        "SCHEMA_UNSUPPORTED",
        "MCP input schema properties must be an object.",
      );
    }
    const patterns = schema.patternProperties;
    if (patterns !== undefined && !isRecord(patterns)) {
      throw new McpError(
        "SCHEMA_UNSUPPORTED",
        "MCP input schema patternProperties must be an object.",
      );
    }

    const patternEntries = Object.entries(patterns ?? {}).map(
      ([patternText, patternSchema]) => {
        if (!isSchema(patternSchema)) {
          throw new McpError(
            "SCHEMA_UNSUPPORTED",
            "MCP patternProperties values must be schemas.",
          );
        }
        try {
          return [new RegExp(patternText, "u"), patternSchema] as const;
        } catch (cause) {
          throw new McpError(
            "SCHEMA_UNSUPPORTED",
            "MCP input schema contains an invalid property pattern.",
            { cause },
          );
        }
      },
    );

    for (const key of keys) {
      let evaluated = false;
      const propertySchema = properties?.[key];
      if (propertySchema !== undefined) {
        if (!isSchema(propertySchema)) {
          throw new McpError(
            "SCHEMA_UNSUPPORTED",
            "MCP properties values must be schemas.",
          );
        }
        evaluated = true;
        validateNode(
          value[key],
          propertySchema,
          context,
          childPath(path, key),
          depth + 1,
        );
      }

      for (const [pattern, patternSchema] of patternEntries) {
        if (pattern.test(key)) {
          evaluated = true;
          validateNode(
            value[key],
            patternSchema,
            context,
            childPath(path, key),
            depth + 1,
          );
        }
      }

      if (!evaluated && schema.additionalProperties !== undefined) {
        if (!isSchema(schema.additionalProperties)) {
          throw new McpError(
            "SCHEMA_UNSUPPORTED",
            "MCP additionalProperties must be a schema or boolean.",
          );
        }
        validateNode(
          value[key],
          schema.additionalProperties,
          context,
          childPath(path, key),
          depth + 1,
        );
      }
    }

    if (schema.propertyNames !== undefined) {
      if (!isSchema(schema.propertyNames)) {
        throw new McpError(
          "SCHEMA_UNSUPPORTED",
          "MCP propertyNames must contain a schema.",
        );
      }
      for (const key of keys) {
        validateNode(
          key,
          schema.propertyNames,
          context,
          childPath(path, key),
          depth + 1,
        );
      }
    }

    if (schema.dependentRequired !== undefined) {
      if (!isRecord(schema.dependentRequired)) {
        throw new McpError(
          "SCHEMA_UNSUPPORTED",
          "MCP dependentRequired must be an object.",
        );
      }
      for (const [key, dependencies] of Object.entries(
        schema.dependentRequired,
      )) {
        if (!(key in value)) continue;
        if (
          !Array.isArray(dependencies) ||
          !dependencies.every((dependency) => typeof dependency === "string")
        ) {
          throw new McpError(
            "SCHEMA_UNSUPPORTED",
            "MCP dependentRequired values must be string arrays.",
          );
        }
        for (const dependency of dependencies as string[]) {
          if (!(dependency in value)) {
            addIssue(
              context,
              childPath(path, dependency),
              "dependentRequired",
              "A dependent property is missing.",
            );
          }
        }
      }
    }
  }
}

export function validateJsonSchema(
  value: unknown,
  schema: JsonSchema,
): JsonSchemaValidationIssue[] {
  const context: ValidationContext = { root: schema, issues: [] };
  validateNode(value, schema, context, "", 0);
  return context.issues;
}

export function assertMcpArgumentsValid(
  value: unknown,
  schema: JsonSchema,
): void {
  if (!isRecord(value)) {
    throw new McpError(
      "ARGUMENT_VALIDATION_FAILED",
      "MCP tool arguments must be a JSON object.",
    );
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (cause) {
    throw new McpError(
      "ARGUMENT_VALIDATION_FAILED",
      "MCP tool arguments must be JSON serializable.",
      { cause },
    );
  }

  if (serialized === undefined || new TextEncoder().encode(serialized).length > 256_000) {
    throw new McpError(
      "ARGUMENT_VALIDATION_FAILED",
      "MCP tool arguments exceed the local size limit.",
    );
  }

  const issues = validateJsonSchema(value, schema);
  if (issues.length > 0) {
    const first = issues[0];
    throw new McpError(
      "ARGUMENT_VALIDATION_FAILED",
      `MCP tool arguments failed ${first.keyword} validation at ${first.path || "/"}.`,
    );
  }
}
