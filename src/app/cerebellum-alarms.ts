import {
  FIXED_CEREBELLUM_ALARM_RULES,
  buildCerebellumAlarmTask,
  getDueCerebellumAlarms,
  toCerebellumBeijingTime,
  type CerebellumAlarmRule,
  type CerebellumAlarmTask,
} from "../domain/cerebellum/index.js";

export interface BuildCerebellumAlarmTasksInput {
  now?: Date | string;
  alarms?: readonly CerebellumAlarmRule[];
  sources?:
    | readonly unknown[]
    | ((alarm: CerebellumAlarmRule) => readonly unknown[]);
  metadata?:
    | Record<string, unknown>
    | ((alarm: CerebellumAlarmRule) => Record<string, unknown>);
}

export interface BuildCerebellumAlarmTasksResult {
  scheduledAt: string;
  beijingDate: string;
  beijingTime: string;
  timezone: "Asia/Shanghai";
  tasks: CerebellumAlarmTask[];
}

export function buildCerebellumAlarmTasks(
  input: BuildCerebellumAlarmTasksInput = {},
): BuildCerebellumAlarmTasksResult {
  const scheduledAt = normalizeDate(input.now).toISOString();
  const beijingTime = toCerebellumBeijingTime(scheduledAt);
  const dueAlarms = getDueCerebellumAlarms({
    now: scheduledAt,
    alarms: input.alarms ?? FIXED_CEREBELLUM_ALARM_RULES,
  });
  const tasks = dueAlarms.map((alarm) =>
    buildCerebellumAlarmTask({
      alarm,
      scheduledAt,
      sources: resolveSources(input.sources, alarm),
      metadata: resolveMetadata(input.metadata, alarm),
    }),
  );

  return {
    scheduledAt,
    beijingDate: beijingTime.date,
    beijingTime: beijingTime.time,
    timezone: "Asia/Shanghai",
    tasks,
  };
}

function resolveSources(
  sources: BuildCerebellumAlarmTasksInput["sources"],
  alarm: CerebellumAlarmRule,
): readonly unknown[] {
  if (!sources) {
    return [];
  }

  return typeof sources === "function" ? sources(alarm) : sources;
}

function resolveMetadata(
  metadata: BuildCerebellumAlarmTasksInput["metadata"],
  alarm: CerebellumAlarmRule,
): Record<string, unknown> {
  if (!metadata) {
    return {};
  }

  return typeof metadata === "function" ? metadata(alarm) : metadata;
}

function normalizeDate(value: Date | string | undefined): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error("Invalid cerebellum alarm task date");
    }

    return value;
  }

  if (typeof value === "string") {
    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`Invalid cerebellum alarm task date: ${value}`);
    }

    return parsed;
  }

  return new Date();
}
