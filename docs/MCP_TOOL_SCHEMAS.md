# MCP Tool Schema Contract

This document describes the schema documents Pi SRE accepts during Phase 1 tool discovery. The implementation lives in [tool-schema.ts](../src/mcp/tool-schema.ts); [tool-discovery.ts](../src/mcp/tool-discovery.ts) validates the enclosing descriptor and applies tool policy.

## Input and output have different roles

MCP tool descriptors declare an `inputSchema` for arguments and may declare an `outputSchema` for structured results. See the [MCP tool definition](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool) and [output schema specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#output-schema). These versioned references describe the object roots used by Pi SRE's current contract.

| Contract       | Presence in a descriptor | Describes                                         | Pi SRE validator          |
| -------------- | ------------------------ | ------------------------------------------------- | ------------------------- |
| `inputSchema`  | Required                 | The `arguments` object supplied to `tools/call`   | `isSupportedInputSchema`  |
| `outputSchema` | Optional                 | The `structuredContent` object returned by a tool | `isSupportedOutputSchema` |

Both validators require an object root and currently share the same supported nested types and keywords. They accept schema documents, not actual arguments or results. Passing `undefined` to either validator returns false; discovery permits an omitted output schema by skipping its validation. A declared `null` output schema is rejected.

## Three levels to keep distinct

```text
Tool descriptor
  ├── inputSchema  ── describes ──> call arguments
  └── outputSchema ── describes ──> result.structuredContent

Pi SRE's TypeBox definitions validate the schema documents above.
```

For example, a tool may declare this input schema:

```json
{
  "type": "object",
  "properties": { "namespace": { "type": "string", "minLength": 1 } },
  "required": ["namespace"],
  "additionalProperties": false
}
```

An argument object satisfying that schema would be:

```json
{ "namespace": "default" }
```

Discovery checks that the schema document has a supported structure. Checking that an actual argument contains a nonempty namespace belongs to the tool bridge in Slice 5. Validating actual structured results is also a separate operation; accepting an output schema does not prove any returned data conforms to it.

## Supported schema documents

Every schema node must be an object with one explicit string `type`. The root must use `"object"`; children may use any type below.

| Type                | Permitted type-specific keywords                                           | Checks during discovery                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `object`            | `properties`, `required`, `additionalProperties`                           | Properties map names to supported child schemas. Required names must refer to own declared properties. Additional properties must be a boolean. |
| `array`             | `items`, `minItems`, `maxItems`                                            | Items must be one supported schema. Length limits must be nonnegative integers.                                                                 |
| `string`            | `minLength`, `maxLength`, `pattern`, `format`                              | Length limits must be nonnegative integers. Pattern and format must be strings.                                                                 |
| `number`, `integer` | `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf` | Each declared constraint must be a finite number.                                                                                               |
| `boolean`, `null`   | None                                                                       | Only common metadata is permitted.                                                                                                              |

Every type also permits these common fields:

| Field                  | Supported shape               |
| ---------------------- | ----------------------------- |
| `title`, `description` | String                        |
| `default`              | Any JSON value                |
| `enum`                 | Nonempty array of JSON values |
| `examples`             | Array of JSON values          |

Only `type` is always required. Arrays additionally require `items`. Objects may omit `properties`, but if `required` is declared, `properties` must also be declared, even for an empty required array.

The root has depth 0. Each property schema or array item schema adds one level. Depth 12 is accepted; depth 13 is rejected. The bounded TypeBox definitions are constructed once and reused.

Unknown fields are rejected. Examples include `$schema`, `$id`, `$ref`, `$defs`, `allOf`, `anyOf`, `oneOf`, `not`, conditional schemas, `patternProperties`, and tuple item arrays. Boolean schemas such as `true` and union types such as `["string", "null"]` are also outside this subset. A schema can be valid JSON Schema and still be unsupported by Pi SRE.

This is a structural compatibility check, not a complete JSON Schema semantic validator. It does not check whether a pattern compiles, a format name is recognized, enum/default values match the declared type, minimum and maximum agree, or `multipleOf` is positive. Those checks must be considered when implementing schema adaptation and argument/result validation; discovery acceptance alone does not establish executable validation support.

The two uses of `additionalProperties: false` in the code have different targets: TypeBox's option rejects unknown fields in a schema document; the server's schema keyword restricts fields in the future arguments or result object. See [JSON Schema object keywords](https://json-schema.org/understanding-json-schema/reference/object).

## Complete examples

### Accepted input schema: no arguments

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

### Accepted output schema: structured context names

This is an illustrative schema, not a claim about the exact Kubernetes MCP Server response.

```json
{
  "type": "object",
  "properties": {
    "contexts": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["contexts"],
  "additionalProperties": false
}
```

A structured result satisfying it would contain:

```json
{ "contexts": ["staging", "production"] }
```

### Rejected input or output schema: undeclared required name

```json
{
  "type": "object",
  "properties": { "name": { "type": "string" } },
  "required": ["namespace"]
}
```

`namespace` has no declaration in `properties`.

### Rejected output schema: array root

```json
{
  "type": "array",
  "items": { "type": "string" }
}
```

An array is permitted as an object property, but neither input nor output permits it as the root.

### Rejected input or output schema: unsupported reference

```json
{
  "type": "object",
  "properties": { "namespace": { "$ref": "#/$defs/namespace" } },
  "$defs": { "namespace": { "type": "string" } }
}
```

Reference resolution and definitions are outside the current subset.

## Discovery and tool policy

An invalid required input schema or a malformed declared output schema rejects the whole descriptor with `invalid-descriptor`. Discovery preserves accepted schema documents without applying defaults, coercing values, or removing unsupported fields.

Schema acceptance is one gate. An exposed tool must also have a unique valid name, match the exact allowlist, declare `readOnlyHint: true`, and avoid `destructiveHint: true`. Known cluster-dependent diagnostic tools remain deferred until explicit cluster scope is implemented. These decisions belong to [tool-policy.ts](../src/runtime/tool-policy.ts), independently of the schema document validators.

## Code map

| Code                                               | Responsibility                                                |
| -------------------------------------------------- | ------------------------------------------------------------- |
| `buildObjectSchemaDocument`                        | Object fields and the required-name refinement                |
| `buildSchemaDocument`                              | Shared nested types, keywords, and depth limit                |
| `InputSchemaDocument` / `isSupportedInputSchema`   | Required argument-schema contract                             |
| `OutputSchemaDocument` / `isSupportedOutputSchema` | Declared structured-result-schema contract                    |
| `parseDescriptor`                                  | Descriptor validation, including optional output handling     |
| `discoverMcpTools`                                 | Discovery, duplicate rejection, sorting, and policy reporting |
