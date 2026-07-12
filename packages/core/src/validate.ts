import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export type SchemaName =
  | 'workforce-package'
  | 'agent'
  | 'skill'
  | 'persona'
  | 'workflow'
  | 'audit-record';

const SCHEMA_NAMES: SchemaName[] = [
  'workforce-package',
  'agent',
  'skill',
  'persona',
  'workflow',
  'audit-record'
];

const schemasDir = fileURLToPath(new URL('../schemas/', import.meta.url));

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default ? addFormats.default(ajv) : (addFormats as unknown as (a: Ajv2020) => void)(ajv);

const validators = new Map<SchemaName, ValidateFunction>();

export function loadSchema(name: SchemaName): Record<string, unknown> {
  return JSON.parse(readFileSync(`${schemasDir}${name}.schema.json`, 'utf8'));
}

function getValidator(name: SchemaName): ValidateFunction {
  let v = validators.get(name);
  if (!v) {
    v = ajv.compile(loadSchema(name));
    validators.set(name, v);
  }
  return v;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Validate a document against one of the FlowForge core schemas. */
export function validate(name: SchemaName, document: unknown): ValidationResult {
  const validator = getValidator(name);
  const valid = validator(document) as boolean;
  return {
    valid,
    errors: valid
      ? []
      : (validator.errors ?? []).map(
          (e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`
        )
  };
}

export function schemaNames(): SchemaName[] {
  return [...SCHEMA_NAMES];
}
