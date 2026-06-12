import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ZodError, type ZodType } from "zod";
import {
  AtomicFileWriter,
  type AtomicWriteOptions,
  type AtomicWriteResult,
} from "./atomic-file-writer.js";
import {
  JsonStoreValidationError,
  StorageError,
  formatStorageZodError,
} from "./errors.js";

export interface JsonStoreOptions<T> {
  filePath: string;
  schema: ZodType<T>;
  writer?: AtomicFileWriter;
  defaultValue?: T;
  pretty?: boolean;
}

export interface JsonStoreWriteOptions extends AtomicWriteOptions {
  newline?: boolean;
}

export class JsonStore<T> {
  private readonly filePath: string;
  private readonly schema: ZodType<T>;
  private readonly writer: AtomicFileWriter;
  private readonly defaultValue?: T;
  private readonly pretty: boolean;

  constructor(options: JsonStoreOptions<T>) {
    this.filePath = path.resolve(options.filePath);
    this.schema = options.schema;
    this.writer = options.writer ?? new AtomicFileWriter();
    this.defaultValue = options.defaultValue;
    this.pretty = options.pretty ?? true;
  }

  exists(): boolean {
    return existsSync(this.filePath);
  }

  getPath(): string {
    return this.filePath;
  }

  read(): T {
    if (!this.exists()) {
      if (this.defaultValue !== undefined) {
        return this.validate(this.defaultValue, "default value");
      }

      throw new StorageError(`JSON store file not found: ${this.filePath}`);
    }

    const raw = this.readRawText();
    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new StorageError(`Failed to parse JSON store file: ${this.filePath}`, {
        cause: error,
      });
    }

    return this.validate(parsed, this.filePath);
  }

  write(value: T, options: JsonStoreWriteOptions = {}): AtomicWriteResult {
    const validated = this.validate(value, "write value");
    const json = JSON.stringify(validated, null, this.pretty ? 2 : 0);
    const content = options.newline === false ? json : `${json}\n`;
    return this.writer.write(this.filePath, content, options);
  }

  update(updater: (current: T) => T, options: JsonStoreWriteOptions = {}): AtomicWriteResult {
    const current = this.read();
    return this.write(updater(current), options);
  }

  private readRawText(): string {
    try {
      return readFileSync(this.filePath, "utf8");
    } catch (error) {
      throw new StorageError(`Failed to read JSON store file: ${this.filePath}`, {
        cause: error,
      });
    }
  }

  private validate(value: unknown, label: string): T {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new JsonStoreValidationError(
          `Invalid JSON store ${label}: ${formatStorageZodError(error)}`,
          { cause: error },
        );
      }

      throw error;
    }
  }
}

