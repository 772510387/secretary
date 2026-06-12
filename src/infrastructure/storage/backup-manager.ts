import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StorageError } from "./errors.js";

export interface BackupOptions {
  enabled?: boolean;
  directory?: string;
  suffix?: string;
}

export class BackupManager {
  createBackup(filePath: string, options: BackupOptions = {}): string | undefined {
    if (options.enabled === false || !existsSync(filePath)) {
      return undefined;
    }

    const stat = statSync(filePath);

    if (!stat.isFile()) {
      throw new StorageError(`Cannot backup non-file path: ${filePath}`);
    }

    const backupDirectory =
      options.directory ?? path.join(path.dirname(filePath), ".backups");
    mkdirSync(backupDirectory, { recursive: true });

    const backupPath = path.join(
      backupDirectory,
      `${path.basename(filePath)}.${timestampForFileName()}.${randomUUID()}${
        options.suffix ?? ".bak"
      }`,
    );

    try {
      copyFileSync(filePath, backupPath);
      return backupPath;
    } catch (error) {
      throw new StorageError(`Failed to create backup for ${filePath}`, { cause: error });
    }
  }
}

function timestampForFileName(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

