import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";

/** A required MCP schema document describing tool-call arguments. */
export interface McpInputSchema extends Readonly<Record<string, unknown>> {
  readonly type: "object";
}

/** An optional MCP schema document describing structuredContent in tool results. */
export interface McpOutputSchema extends Readonly<Record<string, unknown>> {
  readonly type: "object";
}

// These definitions validate a JSON Schema document received from MCP.
// They describe the subset Pi SRE supports, rather than the tool's arguments.
const commonSchemaFields = {
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  default: Type.Optional(Type.Unknown()),
  enum: Type.Optional(Type.Array(Type.Unknown(), { minItems: 1 })),
  examples: Type.Optional(Type.Array(Type.Unknown())),
};

// Length and item limits must be nonnegative integers; numeric bounds must be finite.
const nonNegativeInteger = Type.Optional(Type.Integer({ minimum: 0 }));
const finiteNumber = Type.Optional(Type.Refine(Type.Number(), Number.isFinite));
const numericSchemaFields = {
  minimum: finiteNumber,
  maximum: finiteNumber,
  exclusiveMinimum: finiteNumber,
  exclusiveMaximum: finiteNumber,
  multipleOf: finiteNumber,
};

// Reject keywords outside the supported subset, including $ref and composition keywords.
// This option restricts fields in the schema document we are validating.
const strictSchemaFields = { additionalProperties: false };
const MAX_SCHEMA_DEPTH = 12;

function buildObjectSchemaDocument(child: TSchema): TSchema {
  return Type.Refine(
    Type.Object(
      {
        ...commonSchemaFields,
        type: Type.Literal("object"),
        properties: Type.Optional(Type.Record(Type.String(), child)),
        required: Type.Optional(Type.Array(Type.String())),
        // The tool's additionalProperties keyword supports only a boolean in this subset.
        additionalProperties: Type.Optional(Type.Boolean()),
      },
      strictSchemaFields,
    ),
    // Structural validation checks the field types first. Then ensure every required
    // name refers to a declared property, rather than an inherited JavaScript property.
    (schema) => {
      const properties = schema.properties;
      return (
        schema.required === undefined ||
        (properties !== undefined &&
          schema.required.every((name) => Object.hasOwn(properties, name)))
      );
    },
  );
}

function buildSchemaDocument(depth = 0): TSchema {
  // Every nested property or array item consumes one level. At the limit, children
  // are forbidden so an untrusted schema cannot trigger unbounded validation recursion.
  const child = depth < MAX_SCHEMA_DEPTH ? buildSchemaDocument(depth + 1) : Type.Never();

  // Each branch verifies the permitted fields for one explicit schema type.
  return Type.Union([
    buildObjectSchemaDocument(child),
    Type.Object(
      {
        ...commonSchemaFields,
        type: Type.Literal("array"),
        items: child,
        minItems: nonNegativeInteger,
        maxItems: nonNegativeInteger,
      },
      strictSchemaFields,
    ),
    Type.Object(
      {
        ...commonSchemaFields,
        type: Type.Literal("string"),
        minLength: nonNegativeInteger,
        maxLength: nonNegativeInteger,
        pattern: Type.Optional(Type.String()),
        format: Type.Optional(Type.String()),
      },
      strictSchemaFields,
    ),
    Type.Object(
      { ...commonSchemaFields, type: Type.Literal("number"), ...numericSchemaFields },
      strictSchemaFields,
    ),
    Type.Object(
      { ...commonSchemaFields, type: Type.Literal("integer"), ...numericSchemaFields },
      strictSchemaFields,
    ),
    Type.Object({ ...commonSchemaFields, type: Type.Literal("boolean") }, strictSchemaFields),
    Type.Object({ ...commonSchemaFields, type: Type.Literal("null") }, strictSchemaFields),
  ]);
}

// Input and output roots are separate contracts with the same supported fields today.
// Share the bounded child definitions so nested validation stays consistent.
const NestedSchemaDocument = buildSchemaDocument(1);
const InputSchemaDocument = buildObjectSchemaDocument(NestedSchemaDocument);
const OutputSchemaDocument = buildObjectSchemaDocument(NestedSchemaDocument);

/**
 * Validate the required argument schema document, not actual tool arguments.
 * These examples also illustrate the shared rules used for output schemas.
 * Tool exposure additionally requires a unique allowlisted name and safe annotations.
 * See docs/MCP_TOOL_SCHEMAS.md for the input and output schema contract.
 *
 * VALID: an empty object schema, suitable for a tool with no named arguments.
 * {
 *   "type": "object",
 *   "properties": {},
 *   "additionalProperties": false
 * }
 *
 * VALID: nested fields with supported constraints and declared required names.
 * {
 *   "type": "object",
 *   "properties": {
 *     "target": {
 *       "type": "object",
 *       "properties": { "namespace": { "type": "string", "minLength": 1 } },
 *       "required": ["namespace"],
 *       "additionalProperties": false
 *     },
 *     "names": {
 *       "type": "array",
 *       "items": { "type": "string" },
 *       "minItems": 1,
 *       "maxItems": 10
 *     },
 *     "limit": { "type": "integer", "minimum": 1, "maximum": 100 },
 *     "includeDetails": { "type": "boolean", "default": false }
 *   },
 *   "required": ["target"],
 *   "additionalProperties": false
 * }
 *
 * INVALID: "namespace" is required but has no declaration in properties.
 * {
 *   "type": "object",
 *   "properties": { "name": { "type": "string" } },
 *   "required": ["namespace"]
 * }
 *
 * INVALID: arrays must declare a supported items schema.
 * {
 *   "type": "object",
 *   "properties": { "names": { "type": "array", "minItems": 1 } }
 * }
 *
 * INVALID: references are valid JSON Schema, but outside Pi SRE's supported subset.
 * {
 *   "type": "object",
 *   "properties": { "target": { "$ref": "#/$defs/target" } },
 *   "$defs": { "target": { "type": "string" } }
 * }
 *
 * INVALID: additionalProperties supports a boolean, not a nested schema.
 * {
 *   "type": "object",
 *   "additionalProperties": { "type": "string" }
 * }
 *
 * INVALID: length limits must be nonnegative integers.
 * {
 *   "type": "object",
 *   "properties": { "name": { "type": "string", "minLength": -1 } }
 * }
 */
export function isSupportedInputSchema(value: unknown): value is McpInputSchema {
  return Value.Check(InputSchemaDocument, value);
}

/**
 * Validate a declared output schema, not a tool result or its content blocks.
 * An absent outputSchema is handled by discovery; undefined is not a schema document.
 *
 * VALID output schema:
 * {
 *   "type": "object",
 *   "properties": {
 *     "contexts": { "type": "array", "items": { "type": "string" } }
 *   },
 *   "required": ["contexts"],
 *   "additionalProperties": false
 * }
 *
 * INVALID output schema: a top-level array is outside this contract.
 * { "type": "array", "items": { "type": "string" } }
 *
 * See docs/MCP_TOOL_SCHEMAS.md for the input and output schema contract.
 */
export function isSupportedOutputSchema(value: unknown): value is McpOutputSchema {
  return Value.Check(OutputSchemaDocument, value);
}
