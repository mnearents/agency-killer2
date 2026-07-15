/**
 * Output guardrails — the fail-closed gate between raw LLM output and anything
 * the user sees. Every check fails closed: unparseable/empty/errored = BLOCKED.
 */

export interface GuardrailResult {
  /** Whether the output passed all checks */
  passed: boolean;
  /** Which checks failed (empty if passed) */
  violations: GuardrailViolation[];
}

export interface GuardrailViolation {
  rule: string;
  detail: string;
}

export interface GuardrailOptions {
  /** Banned words/phrases (from brand voice profile) */
  bannedWords?: string[];
  /** Whether to check for PII patterns */
  checkPii?: boolean;
  /** Whether to check for fabricated statistics */
  checkFabricatedStats?: boolean;
  /** If set, parse output as JSON and validate it's well-formed */
  expectJson?: boolean;
  /** Maximum allowed output length in characters */
  maxLength?: number;
}

const PII_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/, label: "email address" },
  { pattern: /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/, label: "phone number" },
  { pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/, label: "credit card number" },
];

const FABRICATED_STAT_PATTERNS: RegExp[] = [
  /\b\d+(\.\d+)?x\s*ROAS\b/i,
  /\$[\d,]+(\.\d{2})?\s*(in\s+)?(revenue|sales|profit|income)/i,
  /(increased|decreased|grew|dropped|rose|fell|improved|declined)\s*(by\s+)?\d+(\.\d+)?%/i,
];

/**
 * Validate LLM output against guardrail rules. Fails closed: any error in
 * the guardrail itself results in a BLOCKED output, never a pass-through.
 */
export function validateOutput(
  output: unknown,
  options: GuardrailOptions = {}
): GuardrailResult {
  const violations: GuardrailViolation[] = [];

  // Fail closed: non-string or empty output is always blocked
  if (output == null || typeof output !== "string" || output.trim() === "") {
    violations.push({
      rule: "empty-output",
      detail: "Output is null, undefined, empty, or whitespace-only",
    });
    return { passed: false, violations };
  }

  const text = output;

  // Max length check
  if (options.maxLength != null && text.length > options.maxLength) {
    violations.push({
      rule: "too-long",
      detail: `Output is ${text.length} characters, max allowed is ${options.maxLength}`,
    });
  }

  // PII detection
  if (options.checkPii) {
    for (const { pattern, label } of PII_PATTERNS) {
      if (pattern.test(text)) {
        violations.push({
          rule: "pii-detected",
          detail: `Output contains ${label}`,
        });
      }
    }
  }

  // Banned words
  if (options.bannedWords && options.bannedWords.length > 0) {
    const lowerText = text.toLowerCase();
    for (const word of options.bannedWords) {
      const wordPattern = new RegExp(`\\b${escapeRegex(word)}\\b`, "i");
      if (wordPattern.test(lowerText)) {
        violations.push({
          rule: "banned-word",
          detail: `Output contains banned word: "${word}"`,
        });
      }
    }
  }

  // Fabricated statistics
  if (options.checkFabricatedStats) {
    for (const pattern of FABRICATED_STAT_PATTERNS) {
      if (pattern.test(text)) {
        violations.push({
          rule: "fabricated-stat",
          detail: `Output contains a specific statistic that may be fabricated: ${pattern.source}`,
        });
      }
    }
  }

  // JSON validation
  if (options.expectJson) {
    try {
      JSON.parse(text);
    } catch {
      violations.push({
        rule: "invalid-json",
        detail: "Output is not valid JSON",
      });
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
