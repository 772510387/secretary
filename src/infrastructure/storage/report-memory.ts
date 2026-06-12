import path from "node:path";
import { z } from "zod";
import {
  generatedReportSchema,
  type GeneratedReport,
  type ReportWriteResult,
  type ReportWriter,
} from "../../app/report-generation.js";
import { AtomicFileWriter } from "./atomic-file-writer.js";
import { JsonStore } from "./json-store.js";

export interface ReportsMemoryPaths {
  reportsDir: string;
  tradingDateDir: string;
  reportPath: string;
}

export interface ReportsMemoryStoreOptions {
  memoryDir: string;
  writer?: AtomicFileWriter;
}

export class ReportsMemoryStore implements ReportWriter {
  private readonly memoryDir: string;
  private readonly writer: AtomicFileWriter;

  constructor(options: ReportsMemoryStoreOptions) {
    this.memoryDir = path.resolve(options.memoryDir);
    this.writer = options.writer ?? new AtomicFileWriter();
  }

  writeReport(report: GeneratedReport): ReportWriteResult {
    const paths = createReportsMemoryPaths(this.memoryDir, report.tradingDate, report.reportType);
    const store = new JsonStore<GeneratedReport>({
      filePath: paths.reportPath,
      schema: generatedReportSchema as z.ZodType<GeneratedReport>,
      writer: this.writer,
    });
    const result = store.write(report);

    return {
      filePath: result.filePath,
      backupPath: result.backupPath,
    };
  }
}

export function createReportsMemoryPaths(
  memoryDir: string,
  tradingDate: string,
  reportType: string,
): ReportsMemoryPaths {
  const reportsDir = path.join(path.resolve(memoryDir), "reports");
  const tradingDateDir = path.join(reportsDir, tradingDate);

  return {
    reportsDir,
    tradingDateDir,
    reportPath: path.join(tradingDateDir, `${reportType}.json`),
  };
}
