/**
 * Minimal JSON-Schema-subset validator (type/properties/required/
 * additionalProperties/items/enum/const/pattern/minItems/maxItems/minimum/
 * maximum) — exactly what schema/bundle.v1.json actually uses. Test-only:
 * proves the CLI's real output conforms to the published schema without
 * adding a JSON-schema library dependency to the shipped CLI.
 */

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
};

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

export function validateAgainstSchema(schema: Schema, value: unknown): string[] {
  const errors: string[] = [];

  function walk(node: Schema, val: unknown, path: string): void {
    if (node.const !== undefined) {
      if (val !== node.const) errors.push(`${path}: expected const ${JSON.stringify(node.const)}, got ${JSON.stringify(val)}`);
      return;
    }
    if (node.enum) {
      if (!node.enum.includes(val)) errors.push(`${path}: value ${JSON.stringify(val)} not in enum`);
      return;
    }

    const actual = typeOf(val);
    if (node.type === "integer") {
      if (actual !== "number" || !Number.isInteger(val)) errors.push(`${path}: expected integer, got ${actual}`);
    } else if (node.type && node.type !== actual) {
      errors.push(`${path}: expected type ${node.type}, got ${actual}`);
      return;
    }

    if (node.type === "object") {
      if (actual !== "object") return;
      const obj = val as Record<string, unknown>;
      for (const req of node.required ?? []) {
        if (!(req in obj)) errors.push(`${path}: missing required property '${req}'`);
      }
      if (node.additionalProperties === false) {
        const allowed = new Set(Object.keys(node.properties ?? {}));
        for (const key of Object.keys(obj)) {
          if (!allowed.has(key)) errors.push(`${path}.${key}: additional property not allowed`);
        }
      }
      for (const [key, childSchema] of Object.entries(node.properties ?? {})) {
        if (key in obj) walk(childSchema, obj[key], `${path}.${key}`);
      }
    } else if (node.type === "array") {
      const arr = val as unknown[];
      if (node.minItems !== undefined && arr.length < node.minItems) {
        errors.push(`${path}: expected at least ${node.minItems} items, got ${arr.length}`);
      }
      if (node.maxItems !== undefined && arr.length > node.maxItems) {
        errors.push(`${path}: expected at most ${node.maxItems} items, got ${arr.length}`);
      }
      if (node.items) {
        arr.forEach((item, i) => walk(node.items as Schema, item, `${path}[${i}]`));
      }
    } else if (node.type === "string") {
      if (node.pattern && !new RegExp(node.pattern).test(val as string)) {
        errors.push(`${path}: value '${String(val)}' does not match pattern ${node.pattern}`);
      }
    } else if (node.type === "integer" || node.type === "number") {
      const num = val as number;
      if (node.minimum !== undefined && num < node.minimum) errors.push(`${path}: ${num} < minimum ${node.minimum}`);
      if (node.maximum !== undefined && num > node.maximum) errors.push(`${path}: ${num} > maximum ${node.maximum}`);
    }
  }

  walk(schema, value, "$");
  return errors;
}
