import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { AtomicFileWriter } from "../infrastructure/storage/index.js";

export interface EnsureMemoryLayoutInput {
  memoryDir: string;
  /** Injectable for tests; defaults to a real AtomicFileWriter. */
  writer?: AtomicFileWriter;
}

export interface EnsureMemoryLayoutResult {
  /** Absolute paths of directories that did not exist and were created this run. */
  created: string[];
  /** Whether MEMORY_INDEX.md was written (only true when it was absent). */
  indexWritten: boolean;
}

/**
 * The canonical memory tree. Kept as relative POSIX-ish segments and joined per-OS so the
 * layout is stable across machines. Order is preserved in the `created` result.
 */
const LAYOUT_DIRS: readonly string[] = [
  "rules",
  "long_term",
  "daily_logs",
  "reviews",
  "history",
  "logs",
  "portfolio/snapshots",
  "market/watchlists",
  "market/cache",
  "plans",
  "proposals",
  "reports",
  "research",
];

const MEMORY_INDEX_FILENAME = "MEMORY_INDEX.md";

/**
 * 资产整理: idempotently materializes the canonical memory directory layout and drops a
 * human-readable Chinese navigation index at `<memoryDir>/MEMORY_INDEX.md`.
 *
 * - Directories are created with mkdir -p semantics; only those genuinely absent before
 *   this run are reported in `created` (so a no-op re-run returns an empty list).
 * - The index is written ONLY when it does not already exist — an operator's edited index
 *   is never clobbered. `indexWritten` reflects whether we wrote it.
 *
 * Pure/offline: filesystem only, no model, no network.
 */
export function ensureMemoryLayout(
  input: EnsureMemoryLayoutInput,
): EnsureMemoryLayoutResult {
  const writer = input.writer ?? new AtomicFileWriter();
  const resolvedMemoryDir = path.resolve(input.memoryDir);
  const created: string[] = [];

  for (const relative of LAYOUT_DIRS) {
    // path.join normalizes the "/" segments to the host separator.
    const absolute = path.join(resolvedMemoryDir, ...relative.split("/"));
    // Record only dirs absent BEFORE we create them. existsSync first, since mkdir -p is
    // silent about which ancestors it had to make.
    if (!existsSync(absolute)) {
      created.push(absolute);
    }
    mkdirSync(absolute, { recursive: true });
  }

  const indexPath = path.join(resolvedMemoryDir, MEMORY_INDEX_FILENAME);
  let indexWritten = false;
  // Never clobber an existing index — operators may have curated it.
  if (!existsSync(indexPath)) {
    writer.write(indexPath, MEMORY_INDEX_CONTENT);
    indexWritten = true;
  }

  return { created, indexWritten };
}

/**
 * Concise Chinese navigation of the memory tree. Static so the index is deterministic and
 * the same on every machine (no timestamps / host paths baked in).
 */
const MEMORY_INDEX_CONTENT = `# 记忆库导航 (MEMORY_INDEX)

本目录是 A 股纸面交易助手的"长期记忆"。各子目录职责如下：

- \`rules/\` — 宪法/规则：硬约束与交易纪律，最高优先级，人工复核后落地。
- \`long_term/\` — 长期经验沉淀：跨周期提炼的经验与教训。
- \`daily_logs/\` — 每日落库快照：盘后 15:30 归档的当日账户快照/摘要。
- \`reviews/\` — 周/月/年复盘：阶段性总结与反思。
- \`history/\` — 个股历史：逐标的的历史记录与轨迹。
- \`portfolio/\` — 账户/持仓/快照：account.json、positions.json 及 \`snapshots/\` 每日全量快照、daily-summary.jsonl 每日一行摘要。
- \`plans/\` — 每日选股计划：按交易日组织的 100→10→待买卖漏斗计划。
- \`proposals/\` — 待复核提案：模型给出、等待人工确认的买卖建议。
- \`market/watchlists/\` — 100 池：每日维护的高关注股票池。
- \`market/cache/\` — 行情缓存：可再生的临时缓存（会被清洗）。
- \`reports/\` — 报告：生成的分析/汇报文档。
- \`research/\` — 调研：联网检索与深度研究产出。
- \`logs/\` — 审计与运行日志：audit-*.jsonl 等不可变记录。
- \`alert_state.json\` — 哨兵冷却态：盯盘哨兵的去重/冷却状态。

说明：\`rules/\`、\`long_term/\`、\`portfolio/\`、\`proposals/\`、\`reviews/\`、\`history/\` 与审计日志为持久资产，清洗任务绝不删除；仅 \`plans/<日期>/\` 与 \`market/cache/\` 中超期的临时产物会被裁剪。
`;
