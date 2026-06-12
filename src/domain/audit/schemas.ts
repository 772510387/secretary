import { z } from "zod";
import {
  identifierSchema,
  isoDateTimeSchema,
  jsonValueSchema,
} from "../shared/index.js";

export const auditActorTypeSchema = z.enum([
  "user",
  "system",
  "brain",
  "broker",
  "scheduler",
  "api",
  "cli",
]);

export const auditActionSchema = z.enum([
  "read",
  "write",
  "suggest",
  "validate",
  "order",
  "notify",
  "config",
  "error",
]);

export const auditSubjectTypeSchema = z.enum([
  "account",
  "position",
  "trade",
  "order",
  "memory",
  "config",
  "report",
  "risk",
  "brain",
  "provider",
  "storage",
]);

export const auditSeveritySchema = z.enum(["debug", "info", "warning", "critical"]);
export const auditResultSchema = z.enum(["success", "failure", "rejected", "skipped"]);

export const auditActorSchema = z
  .object({
    type: auditActorTypeSchema,
    id: identifierSchema.optional(),
  })
  .strict();

export const auditSubjectSchema = z
  .object({
    type: auditSubjectTypeSchema,
    id: identifierSchema.optional(),
  })
  .strict();

export const auditEventSchema = z
  .object({
    eventId: identifierSchema,
    occurredAt: isoDateTimeSchema,
    actor: auditActorSchema,
    action: auditActionSchema,
    subject: auditSubjectSchema,
    severity: auditSeveritySchema,
    result: auditResultSchema,
    message: z.string().trim().min(1).max(1000),
    correlationId: identifierSchema.optional(),
    causationId: identifierSchema.optional(),
    metadata: z.record(jsonValueSchema).optional(),
  })
  .strict();

export type AuditActorType = z.infer<typeof auditActorTypeSchema>;
export type AuditAction = z.infer<typeof auditActionSchema>;
export type AuditSubjectType = z.infer<typeof auditSubjectTypeSchema>;
export type AuditSeverity = z.infer<typeof auditSeveritySchema>;
export type AuditResult = z.infer<typeof auditResultSchema>;
export type AuditActor = z.infer<typeof auditActorSchema>;
export type AuditSubject = z.infer<typeof auditSubjectSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;

