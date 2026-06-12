import path from "node:path";
import { z } from "zod";
import {
  researchReportSchema,
  type ResearchReport,
} from "../../domain/research/index.js";
import { AtomicFileWriter } from "./atomic-file-writer.js";
import { JsonStore } from "./json-store.js";

export interface ResearchMemoryPaths {
  researchDir: string;
  tradingDateDir: string;
  reportPath: string;
}

export interface ResearchMemoryStoreOptions {
  memoryDir: string;
  writer?: AtomicFileWriter;
}

export interface ResearchReportWriteResult {
  filePath: string;
  backupPath?: string;
}

export class ResearchMemoryStore {
  private readonly memoryDir: string;
  private readonly writer: AtomicFileWriter;

  constructor(options: ResearchMemoryStoreOptions) {
    this.memoryDir = path.resolve(options.memoryDir);
    this.writer = options.writer ?? new AtomicFileWriter();
  }

  writeReport(report: ResearchReport): ResearchReportWriteResult {
    const paths = createResearchMemoryPaths(this.memoryDir, report.tradingDate, report.reportId);
    const store = new JsonStore<ResearchReport>({
      filePath: paths.reportPath,
      schema: researchReportSchema as z.ZodType<ResearchReport>,
      writer: this.writer,
    });
    const result = store.write(report);

    return {
      filePath: result.filePath,
      backupPath: result.backupPath,
    };
  }
}

export function createResearchMemoryPaths(
  memoryDir: string,
  tradingDate: string,
  reportId: string,
): ResearchMemoryPaths {
  const researchDir = path.join(path.resolve(memoryDir), "research");
  const tradingDateDir = path.join(researchDir, tradingDate);

  return {
    researchDir,
    tradingDateDir,
    reportPath: path.join(tradingDateDir, `${safeFileName(reportId)}.json`),
  };
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 128) || "research-report";
}
