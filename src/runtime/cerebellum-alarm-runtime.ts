import {
  FIXED_CEREBELLUM_ALARM_RULES,
  buildCerebellumAlarmTask,
  isCerebellumAlarmDueAtBeijingTime,
  type CerebellumAlarmRule,
  type CerebellumAlarmTask,
} from "../domain/cerebellum/index.js";
import type {
  AlarmJobRegistry,
  SchedulerTaskContext,
} from "../infrastructure/scheduler/index.js";

export interface RegisterCerebellumAlarmMatrixOptions {
  alarms?: readonly CerebellumAlarmRule[];
  sources?: (
    alarm: CerebellumAlarmRule,
    context: SchedulerTaskContext,
  ) => readonly unknown[];
  metadata?: (
    alarm: CerebellumAlarmRule,
    context: SchedulerTaskContext,
  ) => Record<string, unknown>;
  onTask?: (
    task: CerebellumAlarmTask,
    context: SchedulerTaskContext,
  ) => void | Promise<void>;
}

export function registerCerebellumAlarmMatrix(
  registry: AlarmJobRegistry,
  options: RegisterCerebellumAlarmMatrixOptions = {},
): CerebellumAlarmRule[] {
  const alarms = [...(options.alarms ?? FIXED_CEREBELLUM_ALARM_RULES)];

  for (const alarm of alarms) {
    registry.register({
      jobId: alarm.jobId,
      beijingTime: alarm.beijingTime,
      weekdaysOnly: alarm.weekdaysOnly,
      description: alarm.description,
      shouldRun: (beijingTime) => isCerebellumAlarmDueAtBeijingTime(alarm, beijingTime),
      task: async (context) => {
        const task = buildCerebellumAlarmTask({
          alarm,
          scheduledAt: context.scheduledAt,
          sources: options.sources?.(alarm, context) ?? [],
          metadata: options.metadata?.(alarm, context) ?? {},
        });

        await options.onTask?.(task, context);
      },
    });
  }

  return alarms;
}
