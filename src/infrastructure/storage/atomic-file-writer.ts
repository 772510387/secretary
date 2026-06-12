import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BackupManager, type BackupOptions } from "./backup-manager.js";
import { StorageError } from "./errors.js";

export interface AtomicWriteOptions {
  backup?: boolean | BackupOptions;
  createDirectories?: boolean;
  encoding?: BufferEncoding;
}

export interface AtomicWriteResult {
  filePath: string;
  backupPath?: string;
}

export class AtomicFileWriter {
  constructor(private readonly backupManager = new BackupManager()) {}

  write(filePath: string, content: string, options: AtomicWriteOptions = {}): AtomicWriteResult {
    const targetPath = path.resolve(filePath);
    const directory = path.dirname(targetPath);

    if (options.createDirectories !== false) {
      mkdirSync(directory, { recursive: true });
    }

    const backupPath = this.createBackup(targetPath, options.backup);
    const tempPath = path.join(
      directory,
      `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
    );

    try {
      writeFileSync(tempPath, content, { encoding: options.encoding ?? "utf8", flag: "wx" });
      renameSync(tempPath, targetPath);
      return { filePath: targetPath, backupPath };
    } catch (error) {
      rmSync(tempPath, { force: true });
      throw new StorageError(`Failed to atomically write ${targetPath}`, { cause: error });
    }
  }

  private createBackup(
    targetPath: string,
    backup: boolean | BackupOptions | undefined,
  ): string | undefined {
    if (backup === false) {
      return undefined;
    }

    if (backup === true || backup === undefined) {
      return this.backupManager.createBackup(targetPath);
    }

    return this.backupManager.createBackup(targetPath, backup);
  }
}

