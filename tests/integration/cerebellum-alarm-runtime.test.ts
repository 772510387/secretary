import { describe, expect, it } from "vitest";
import { buildCerebellumAlarmTasks } from "../../src/app/index.js";
import {
  type CerebellumAlarmRule,
  type CerebellumAlarmTask,
} from "../../src/domain/cerebellum/index.js";
import {
  createSchedulerRuntime,
  registerCerebellumAlarmMatrix,
} from "../../src/runtime/index.js";

describe("cerebellum fixed alarm runtime", () => {
  it("registers fixed Beijing alarms and triggers planned tasks without daemon or broker", async () => {
    const runtime = createSchedulerRuntime();
    const tasks: CerebellumAlarmTask[] = [];

    registerCerebellumAlarmMatrix(runtime.alarms, {
      sources: (alarm) => [sourceForAlarm(alarm)],
      metadata: (alarm) => ({
        alarmType: alarm.alarmType,
        apiKey: "sk-runtime-secret-123456",
      }),
      onTask: (task) => {
        tasks.push(task);
      },
    });

    const noMonthEnd = await runtime.alarms.runDue(new Date("2026-06-29T12:00:00.000Z"));
    const preMarket = await runtime.alarms.runDue(new Date("2026-06-12T00:30:00.000Z"));
    const duplicatePreMarket = await runtime.alarms.runDue(new Date("2026-06-12T00:30:30.000Z"));
    const weekly = await runtime.alarms.runDue(new Date("2026-06-13T02:00:00.000Z"));
    const monthly = await runtime.alarms.runDue(new Date("2026-06-30T12:00:00.000Z"));
    const yearEnd = await runtime.alarms.runDue(new Date("2026-12-31T12:00:00.000Z"));

    expect(noMonthEnd).toEqual([]);
    expect(preMarket).toHaveLength(1);
    expect(preMarket[0]?.status).toBe("completed");
    expect(duplicatePreMarket).toEqual([]);
    expect(weekly).toHaveLength(1);
    expect(monthly).toHaveLength(1);
    expect(yearEnd).toHaveLength(2);
    expect(tasks.map((task) => task.alarmType)).toEqual([
      "pre_market_plan",
      "weekly_review",
      "monthly_review",
      "monthly_review",
      "yearly_review",
    ]);
    expect(tasks.every((task) => task.executionGuard.brokerSubmissionAllowed === false)).toBe(true);
    expect(tasks.every((task) => task.executionGuard.accountWriteAllowed === false)).toBe(true);
    expect(tasks.every((task) => task.executionGuard.liveTradingAllowed === false)).toBe(true);
    expect(tasks.every((task) => task.contextPackage.beijingTime.timezone === "Asia/Shanghai")).toBe(
      true,
    );
    expect(JSON.stringify(tasks)).not.toContain("sk-runtime-secret");
    expect(tasks[0]).toMatchObject({
      alarmType: "pre_market_plan",
      contextPackage: {
        sources: [
          {
            relativePath: "memory/reports/2026-06-12/pre_market_plan.json",
            summary: "Mock source summary only.",
          },
        ],
        metadata: {
          apiKey: "[redacted]",
          brokerConnected: false,
          directExecutionAllowed: false,
        },
      },
    });
  });

  it("can build due tasks directly at the app layer without starting scheduler loops", () => {
    const result = buildCerebellumAlarmTasks({
      now: "2026-12-31T12:00:00.000Z",
      sources: (alarm) => [sourceForAlarm(alarm)],
      metadata: {
        directExecutionAllowed: false,
      },
    });

    expect(result).toMatchObject({
      beijingDate: "2026-12-31",
      beijingTime: "20:00:00",
      timezone: "Asia/Shanghai",
    });
    expect(result.tasks.map((task) => task.alarmType)).toEqual([
      "monthly_review",
      "yearly_review",
    ]);
    expect(result.tasks.every((task) => task.status === "planned")).toBe(true);
    expect(result.tasks.every((task) => task.executionGuard.toolExecutionAllowed === false)).toBe(
      true,
    );
  });
});

function sourceForAlarm(alarm: CerebellumAlarmRule): Record<string, unknown> {
  return {
    sourceId: `source-${alarm.alarmId}`,
    category: "reports",
    relativePath: `memory/reports/2026-06-12/${alarm.alarmType}.json`,
    title: `${alarm.alarmType} mock context`,
    summary: "Mock source summary only.",
    metadata: {
      alarmId: alarm.alarmId,
    },
  };
}
