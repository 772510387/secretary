import path from "node:path";
import { z } from "zod";
import {
  auditEventSchema,
  type AuditEvent,
} from "../../domain/audit/index.js";
import {
  killSwitchStateSchema,
  type KillSwitchState,
} from "../../domain/risk/index.js";
import {
  liveAccountAllowlistSchema,
  maskAccountId,
  type LiveAccountAllowlist,
} from "../../domain/trading/index.js";
import { appendAuditEvent } from "../logging/index.js";
import {
  AtomicFileWriter,
  type AtomicWriteResult,
} from "./atomic-file-writer.js";
import { JsonStore } from "./json-store.js";

export interface LiveTradingSafetyPaths {
  brokerDir: string;
  riskDir: string;
  logsDir: string;
  allowlistPath: string;
  killSwitchPath: string;
  auditLogPath: string;
}

export interface LiveTradingSafetyStoreOptions {
  memoryDir: string;
  writer?: AtomicFileWriter;
  now?: () => Date;
  idGenerator?: () => string;
}

export interface LiveTradingSafetyWriteResult<T> extends AtomicWriteResult {
  value: T;
  auditLogPath: string;
  auditBackupPath?: string;
}

export class LiveTradingSafetyStore {
  private readonly memoryDir: string;
  private readonly writer: AtomicFileWriter;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;

  constructor(options: LiveTradingSafetyStoreOptions) {
    this.memoryDir = path.resolve(options.memoryDir);
    this.writer = options.writer ?? new AtomicFileWriter();
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
  }

  paths(occurredAt: string = this.isoNow()): LiveTradingSafetyPaths {
    return createLiveTradingSafetyPaths(this.memoryDir, occurredAt);
  }

  readAllowlist(): LiveAccountAllowlist | undefined {
    const store = this.allowlistStore();
    return store.exists() ? store.read() : undefined;
  }

  writeAllowlist(
    allowlistInput: LiveAccountAllowlist,
  ): LiveTradingSafetyWriteResult<LiveAccountAllowlist> {
    const occurredAt = this.isoNow();
    const allowlist = liveAccountAllowlistSchema.parse(allowlistInput);
    const paths = this.paths(occurredAt);
    const write = this.allowlistStore().write(allowlist);
    const auditWrite = appendAuditEvent(
      paths.auditLogPath,
      auditEventForAllowlist(allowlist, {
        occurredAt,
        eventId: `audit-live-allowlist-${safeIdentifier(this.idGenerator())}`,
        filePath: write.filePath,
        backupPath: write.backupPath,
      }),
      this.writer,
    );

    return {
      ...write,
      value: allowlist,
      auditLogPath: auditWrite.filePath,
      auditBackupPath: auditWrite.backupPath,
    };
  }

  readKillSwitch(): KillSwitchState | undefined {
    const store = this.killSwitchStore();
    return store.exists() ? store.read() : undefined;
  }

  writeKillSwitch(
    stateInput: KillSwitchState,
  ): LiveTradingSafetyWriteResult<KillSwitchState> {
    const occurredAt = this.isoNow();
    const state = killSwitchStateSchema.parse(stateInput);
    const paths = this.paths(occurredAt);
    const write = this.killSwitchStore().write(state);
    const auditWrite = appendAuditEvent(
      paths.auditLogPath,
      auditEventForKillSwitch(state, {
        occurredAt,
        eventId: `audit-kill-switch-${safeIdentifier(this.idGenerator())}`,
        filePath: write.filePath,
        backupPath: write.backupPath,
      }),
      this.writer,
    );

    return {
      ...write,
      value: state,
      auditLogPath: auditWrite.filePath,
      auditBackupPath: auditWrite.backupPath,
    };
  }

  private allowlistStore(): JsonStore<LiveAccountAllowlist> {
    return new JsonStore({
      filePath: this.paths().allowlistPath,
      schema: liveAccountAllowlistSchema as z.ZodType<LiveAccountAllowlist>,
      writer: this.writer,
    });
  }

  private killSwitchStore(): JsonStore<KillSwitchState> {
    return new JsonStore({
      filePath: this.paths().killSwitchPath,
      schema: killSwitchStateSchema as z.ZodType<KillSwitchState>,
      writer: this.writer,
    });
  }

  private isoNow(): string {
    const value = this.now();

    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new Error("LiveTradingSafetyStore now() returned an invalid Date");
    }

    return value.toISOString();
  }
}

export function createLiveTradingSafetyPaths(
  memoryDir: string,
  occurredAt: string = new Date().toISOString(),
): LiveTradingSafetyPaths {
  const resolvedMemoryDir = path.resolve(memoryDir);
  const date = occurredAt.slice(0, 10);

  return {
    brokerDir: path.join(resolvedMemoryDir, "broker"),
    riskDir: path.join(resolvedMemoryDir, "risk"),
    logsDir: path.join(resolvedMemoryDir, "logs"),
    allowlistPath: path.join(resolvedMemoryDir, "broker", "live-account-allowlist.json"),
    killSwitchPath: path.join(resolvedMemoryDir, "risk", "kill-switch.json"),
    auditLogPath: path.join(resolvedMemoryDir, "logs", `audit-${date}.jsonl`),
  };
}

function auditEventForAllowlist(
  allowlist: LiveAccountAllowlist,
  options: {
    occurredAt: string;
    eventId: string;
    filePath: string;
    backupPath?: string;
  },
): AuditEvent {
  return auditEventSchema.parse({
    eventId: options.eventId,
    occurredAt: options.occurredAt,
    actor: {
      type: "system",
      id: "live-trading-safety-store",
    },
    action: "config",
    subject: {
      type: "config",
      id: allowlist.allowlistId,
    },
    severity: "warning",
    result: "success",
    message: "Live account allowlist written",
    metadata: {
      allowlistId: allowlist.allowlistId,
      entryCount: allowlist.entries.length,
      enabledCount: allowlist.entries.filter((entry) => entry.status === "enabled").length,
      maskedAccounts: allowlist.entries.map((entry) => maskAccountId(entry.accountId)),
      brokerProviders: [...new Set(allowlist.entries.map((entry) => entry.brokerProvider))],
      filePath: path.normalize(options.filePath),
      backupPath: options.backupPath ? path.normalize(options.backupPath) : null,
      containsRealAccountSecret: false,
      liveTradingGateOnly: true,
    },
  });
}

function auditEventForKillSwitch(
  state: KillSwitchState,
  options: {
    occurredAt: string;
    eventId: string;
    filePath: string;
    backupPath?: string;
  },
): AuditEvent {
  return auditEventSchema.parse({
    eventId: options.eventId,
    occurredAt: options.occurredAt,
    actor: {
      type: "system",
      id: "live-trading-safety-store",
    },
    action: "config",
    subject: {
      type: "risk",
      id: state.stateId,
    },
    severity: state.rules.some((rule) => rule.mode !== "clear") ? "critical" : "info",
    result: "success",
    message: "Kill switch state written",
    metadata: {
      stateId: state.stateId,
      ruleCount: state.rules.length,
      activeRuleCount: state.rules.filter((rule) => rule.mode !== "clear").length,
      rules: state.rules.map((rule) => ({
        ruleId: rule.ruleId,
        scope: rule.scope,
        mode: rule.mode,
        account: rule.accountId ? maskAccountId(rule.accountId) : null,
        symbol: rule.symbol ? `${rule.market}:${rule.symbol}` : null,
        expiresAt: rule.expiresAt ?? null,
      })),
      filePath: path.normalize(options.filePath),
      backupPath: options.backupPath ? path.normalize(options.backupPath) : null,
      brokerConnected: false,
      orderSubmitted: false,
    },
  });
}

function safeIdentifier(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 128);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "id";
}
