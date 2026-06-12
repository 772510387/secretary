import { z } from "zod";
import { ResearchValidationError } from "./errors.js";
import {
  researchReportSchema,
  researchTaskSchema,
  type ResearchReport,
  type ResearchTask,
} from "./schemas.js";

export function validateResearchTask(input: unknown): ResearchTask {
  return parseOrThrow(() => researchTaskSchema.parse(input), "Invalid research task");
}

export function validateResearchReport(input: unknown): ResearchReport {
  return parseOrThrow(() => researchReportSchema.parse(input), "Invalid research report");
}

function parseOrThrow<T>(parse: () => T, message: string): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ResearchValidationError) {
      throw error;
    }

    throw new ResearchValidationError(formatValidationMessage(message, error), {
      cause: error,
    });
  }
}

function formatValidationMessage(message: string, error: unknown): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];

    if (issue) {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${message}: ${path} ${issue.message}`;
    }
  }

  return message;
}
