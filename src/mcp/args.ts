/**
 * MCP argument parsing — strict, fail-closed validation of tool inputs.
 *
 * Tool arguments arrive as untyped JSON chosen by a model, so this is a
 * trust boundary, not a formality. Two rules do most of the work:
 *
 *  1. An argument the tool didn't declare is an ERROR, not something to
 *     ignore. Quietly dropping a hallucinated `campaign` filter leaves the
 *     model believing it narrowed a result set it actually read whole.
 *  2. Anything unparseable is rejected. No coercion to NaN, no Date silently
 *     rolling 2026-02-30 into March.
 */

export class McpArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpArgumentError";
  }
}

export type ArgSpec =
  | { type: "string"; required?: boolean; default?: string }
  | { type: "integer"; required?: boolean; default?: number; min?: number; max?: number }
  | { type: "boolean"; required?: boolean; default?: boolean }
  | { type: "enum"; values: readonly string[]; required?: boolean; default?: string }
  | { type: "date"; required?: boolean };

export type ArgSchema = Record<string, ArgSpec>;

export type ParsedArgs = Record<string, string | number | boolean | Date>;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(key: string, raw: unknown): Date {
  if (typeof raw !== "string" || !DATE_PATTERN.test(raw)) {
    throw new McpArgumentError(`"${key}" must be a date in YYYY-MM-DD format, got: ${JSON.stringify(raw)}`);
  }
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  // Date happily accepts 2026-02-30 and rolls it to March 2nd. Round-tripping
  // catches that, so a typo fails instead of quietly shifting the window.
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw new McpArgumentError(`"${key}" is not a real calendar date: ${raw}`);
  }
  return parsed;
}

function parseInteger(key: string, raw: unknown, spec: { min?: number; max?: number }): number {
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new McpArgumentError(`"${key}" must be a whole number, got: ${JSON.stringify(raw)}`);
  }
  if (spec.min !== undefined && value < spec.min) {
    throw new McpArgumentError(`"${key}" must be at least ${spec.min}, got ${value}`);
  }
  if (spec.max !== undefined && value > spec.max) {
    throw new McpArgumentError(`"${key}" must be at most ${spec.max}, got ${value}`);
  }
  return value;
}

function parseOne(key: string, raw: unknown, spec: ArgSpec): string | number | boolean | Date {
  switch (spec.type) {
    case "string":
      if (typeof raw !== "string") {
        throw new McpArgumentError(`"${key}" must be a string, got: ${JSON.stringify(raw)}`);
      }
      return raw;
    case "integer":
      return parseInteger(key, raw, spec);
    case "boolean":
      if (typeof raw !== "boolean") {
        throw new McpArgumentError(`"${key}" must be true or false, got: ${JSON.stringify(raw)}`);
      }
      return raw;
    case "enum":
      if (typeof raw !== "string" || !spec.values.includes(raw)) {
        throw new McpArgumentError(
          `"${key}" must be one of: ${spec.values.join(", ")}. Got: ${JSON.stringify(raw)}`
        );
      }
      return raw;
    case "date":
      return parseDate(key, raw);
  }
}

export function parseArgs(
  args: Record<string, unknown> | undefined,
  schema: ArgSchema
): ParsedArgs {
  const provided = args ?? {};
  const allowed = Object.keys(schema);

  for (const key of Object.keys(provided)) {
    if (!(key in schema)) {
      throw new McpArgumentError(
        `Unknown argument "${key}". This tool accepts: ${allowed.join(", ") || "(no arguments)"}`
      );
    }
  }

  const parsed: ParsedArgs = {};
  for (const [key, spec] of Object.entries(schema)) {
    const raw = provided[key];
    if (raw === undefined || raw === null) {
      if (spec.required) {
        throw new McpArgumentError(`Missing required argument "${key}"`);
      }
      if ("default" in spec && spec.default !== undefined) {
        parsed[key] = spec.default;
      }
      continue;
    }
    parsed[key] = parseOne(key, raw, spec);
  }

  return parsed;
}

/** Every date-ranged tool shares this shape: a trailing window, or explicit bounds. */
export const RANGE_SCHEMA = {
  days: { type: "integer", min: 1, max: 730 },
  startDate: { type: "date" },
  endDate: { type: "date" },
} as const satisfies ArgSchema;

export interface DateRange {
  startDate: Date;
  endDate: Date;
}

/**
 * Most tools look backwards at what happened. The calendar looks forwards at
 * what is planned, so the same `days` argument has to mean the opposite there.
 */
export type RangeDirection = "back" | "forward";

export function resolveRange(
  args: ParsedArgs,
  now: Date,
  defaultDays: number,
  direction: RangeDirection = "back"
): DateRange {
  const { days, startDate, endDate } = args as {
    days?: number;
    startDate?: Date;
    endDate?: Date;
  };

  if (days !== undefined && (startDate || endDate)) {
    throw new McpArgumentError(
      `Pass either "days" or an explicit startDate/endDate pair, not both.`
    );
  }

  if (startDate || endDate) {
    if (!startDate || !endDate) {
      throw new McpArgumentError(`"startDate" and "endDate" must be given together.`);
    }
    if (startDate > endDate) {
      throw new McpArgumentError(`"startDate" must fall before "endDate".`);
    }
    // Dates arrive as UTC midnight; without this the final day is excluded.
    return {
      startDate,
      endDate: new Date(endDate.getTime() + 24 * 60 * 60 * 1000 - 1),
    };
  }

  const windowMs = (days ?? defaultDays) * 24 * 60 * 60 * 1000;
  return direction === "forward"
    ? { startDate: now, endDate: new Date(now.getTime() + windowMs) }
    : { startDate: new Date(now.getTime() - windowMs), endDate: now };
}
