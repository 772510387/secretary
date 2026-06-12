import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AtomicFileWriter,
  JsonStore,
  JsonStoreValidationError,
  StorageError,
} from "../../src/infrastructure/storage/index.js";

const tempRoots: string[] = [];

const accountSchema = z
  .object({
    accountId: z.string().min(1),
    cash: z.number().nonnegative(),
    updatedAt: z.string().datetime(),
  })
  .strict();

type AccountFixture = z.infer<typeof accountSchema>;

describe("JsonStore", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();

      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("returns a validated default value when the file is missing", () => {
    const root = createTempRoot();
    const defaultAccount = createAccount({ cash: 20000 });
    const store = new JsonStore({
      filePath: path.join(root, "memory", "portfolio", "account.json"),
      schema: accountSchema,
      defaultValue: defaultAccount,
    });

    expect(store.exists()).toBe(false);
    expect(store.read()).toEqual(defaultAccount);
  });

  it("writes valid JSON through an atomic file writer and reads it back", () => {
    const root = createTempRoot();
    const filePath = path.join(root, "nested", "account.json");
    const store = createAccountStore(filePath);

    const result = store.write(createAccount({ cash: 18000 }));

    expect(result.filePath).toBe(filePath);
    expect(result.backupPath).toBeUndefined();
    expect(store.read()).toEqual(createAccount({ cash: 18000 }));
    expect(readFileSync(filePath, "utf8")).toMatch(/\n$/);
    expect(listTempFiles(path.dirname(filePath))).toEqual([]);
  });

  it("creates a backup before overwriting an existing JSON file", () => {
    const root = createTempRoot();
    const filePath = path.join(root, "account.json");
    const store = createAccountStore(filePath);

    store.write(createAccount({ cash: 10000 }), { backup: false });
    const result = store.write(createAccount({ cash: 12000 }));

    expect(result.backupPath).toBeDefined();
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(JSON.parse(readFileSync(result.backupPath!, "utf8"))).toEqual(
      createAccount({ cash: 10000 }),
    );
    expect(store.read()).toEqual(createAccount({ cash: 12000 }));
  });

  it("rejects invalid writes before backup and keeps the original file intact", () => {
    const root = createTempRoot();
    const filePath = path.join(root, "account.json");
    const store = createAccountStore(filePath);

    store.write(createAccount({ cash: 10000 }), { backup: false });
    const before = readFileSync(filePath, "utf8");

    expect(() =>
      store.write({ accountId: "paper", cash: -1, updatedAt: validDate } as AccountFixture),
    ).toThrow(JsonStoreValidationError);

    expect(readFileSync(filePath, "utf8")).toBe(before);
    expect(existsSync(path.join(root, ".backups"))).toBe(false);
  });

  it("throws a validation error when an existing file does not match schema", () => {
    const root = createTempRoot();
    const filePath = path.join(root, "account.json");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ accountId: "paper", cash: "bad" }), "utf8");
    const store = createAccountStore(filePath);

    expect(() => store.read()).toThrow(JsonStoreValidationError);
    expect(() => store.read()).toThrow(/cash/);
  });

  it("wraps malformed JSON read failures as storage errors", () => {
    const root = createTempRoot();
    const filePath = path.join(root, "account.json");
    writeFileSync(filePath, "{bad json", "utf8");
    const store = createAccountStore(filePath);

    expect(() => store.read()).toThrow(StorageError);
    expect(() => store.read()).toThrow(/Failed to parse JSON store file/);
  });
});

describe("AtomicFileWriter", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();

      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("can write plain text atomically without creating a backup", () => {
    const root = createTempRoot();
    const filePath = path.join(root, "notes", "state.txt");
    const writer = new AtomicFileWriter();

    const result = writer.write(filePath, "ok", { backup: false });

    expect(result).toEqual({ filePath });
    expect(readFileSync(filePath, "utf8")).toBe("ok");
    expect(listTempFiles(path.dirname(filePath))).toEqual([]);
  });
});

const validDate = "2026-06-12T00:00:00.000Z";

function createAccount(overrides: Partial<AccountFixture> = {}): AccountFixture {
  return {
    accountId: "paper",
    cash: 20000,
    updatedAt: validDate,
    ...overrides,
  };
}

function createAccountStore(filePath: string): JsonStore<AccountFixture> {
  return new JsonStore({
    filePath,
    schema: accountSchema,
  });
}

function createTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "secretary-storage-"));
  tempRoots.push(root);
  return root;
}

function listTempFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tmp"))
    .map((entry) => entry.name);
}

