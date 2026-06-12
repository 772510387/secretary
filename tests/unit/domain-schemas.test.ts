import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  accountSchema,
  positionSchema,
  tradeRecordSchema,
} from "../../src/domain/portfolio/index.js";
import { auditEventSchema } from "../../src/domain/audit/index.js";

describe("portfolio schemas", () => {
  it("validates account fixtures", () => {
    expect(accountSchema.safeParse(readFixture("account.valid.json")).success).toBe(true);
    expect(accountSchema.safeParse(readFixture("account.invalid.json")).success).toBe(false);
  });

  it("validates position fixtures and quantity consistency", () => {
    expect(positionSchema.safeParse(readFixture("position.valid.json")).success).toBe(true);
    const invalid = positionSchema.safeParse(readFixture("position.invalid.json"));

    expect(invalid.success).toBe(false);
    expect(formatIssues(invalid)).toContain(
      "availableQuantity plus frozenQuantity cannot exceed quantity",
    );
  });

  it("validates trade record fixtures", () => {
    expect(tradeRecordSchema.safeParse(readFixture("trade-record.valid.json")).success).toBe(
      true,
    );
    expect(tradeRecordSchema.safeParse(readFixture("trade-record.invalid.json")).success).toBe(
      false,
    );
  });
});

describe("audit schemas", () => {
  it("validates audit event fixtures", () => {
    expect(auditEventSchema.safeParse(readFixture("audit-event.valid.json")).success).toBe(
      true,
    );
    expect(auditEventSchema.safeParse(readFixture("audit-event.invalid.json")).success).toBe(
      false,
    );
  });

  it("accepts JSON metadata but rejects non-JSON values", () => {
    const event = readObjectFixture("audit-event.valid.json");

    expect(
      auditEventSchema.safeParse({
        ...event,
        metadata: {
          nested: {
            values: [1, "two", true, null],
          },
        },
      }).success,
    ).toBe(true);

    expect(
      auditEventSchema.safeParse({
        ...event,
        metadata: {
          invalid: Number.NaN,
        },
      }).success,
    ).toBe(false);
  });
});

describe("data schema contracts", () => {
  it.each([
    "account.schema.json",
    "position.schema.json",
    "trade-record.schema.json",
    "audit-event.schema.json",
  ])("parses %s as JSON schema metadata", (fileName) => {
    const schema = readDataSchema(fileName);

    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toContain(fileName);
    expect(schema.additionalProperties).toBe(false);
  });
});

function readFixture(fileName: string): unknown {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), "tests", "fixtures", fileName), "utf8"),
  ) as unknown;
}

function readObjectFixture(fileName: string): Record<string, unknown> {
  const value = readFixture(fileName);

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Fixture ${fileName} is not an object`);
  }

  return value as Record<string, unknown>;
}

function readDataSchema(fileName: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), "data", "schemas", fileName), "utf8"),
  ) as Record<string, unknown>;
}

function formatIssues(result: ReturnType<typeof positionSchema.safeParse>): string {
  if (result.success) {
    return "";
  }

  return result.error.issues.map((issue) => issue.message).join("; ");
}
