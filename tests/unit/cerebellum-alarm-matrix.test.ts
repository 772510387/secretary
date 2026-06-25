import { describe, expect, it } from "vitest";
import {
  FIXED_CEREBELLUM_ALARM_RULES,
  buildCerebellumAlarmTask,
  buildCerebellumAlarmSop,
  getDueCerebellumAlarms,
  isCerebellumAlarmDue,
  renderCerebellumAlarmSop,
  toCerebellumBeijingTime,
} from "../../src/domain/cerebellum/index.js";

describe("fixed cerebellum alarm matrix", () => {
  it("defines the required Beijing alarm matrix", () => {
    expect(
      FIXED_CEREBELLUM_ALARM_RULES.map((alarm) => [
        alarm.alarmId,
        alarm.alarmType,
        alarm.beijingTime,
        alarm.timezone,
        alarm.brainTaskType,
      ]),
    ).toEqual([
      ["data-warmup", "data_warmup", "08:00", "Asia/Shanghai", "pre_market_plan"],
      ["overnight-digest", "overnight_digest", "08:15", "Asia/Shanghai", "pre_market_plan"],
      ["pre-market-plan", "pre_market_plan", "08:30", "Asia/Shanghai", "pre_market_plan"],
      ["call-auction-watch", "call_auction_watch", "09:15", "Asia/Shanghai", "pre_market_plan"],
      ["pre-open-confirmation", "pre_open_confirmation", "09:25", "Asia/Shanghai", "pre_market_plan"],
      ["morning-review", "morning_review", "10:00", "Asia/Shanghai", "midday_review"],
      ["midday-review", "midday_review", "11:30", "Asia/Shanghai", "midday_review"],
      ["afternoon-risk-scan", "afternoon_risk_scan", "14:00", "Asia/Shanghai", "midday_review"],
      ["late-session-plan", "late_session_plan", "14:30", "Asia/Shanghai", "midday_review"],
      ["closing-snapshot", "closing_snapshot", "15:00", "Asia/Shanghai", "closing_review"],
      ["post-close-review", "post_close_review", "15:30", "Asia/Shanghai", "closing_review"],
      ["deep-review", "deep_review", "20:30", "Asia/Shanghai", "daily_reflection"],
      ["next-day-watchlist", "next_day_watchlist", "21:00", "Asia/Shanghai", "daily_reflection"],
      ["daily-reflection", "daily_reflection", "00:00", "Asia/Shanghai", "daily_reflection"],
      ["weekly-review", "weekly_review", "10:00", "Asia/Shanghai", "daily_reflection"],
      ["monthly-review", "monthly_review", "20:00", "Asia/Shanghai", "daily_reflection"],
      ["yearly-review", "yearly_review", "20:00", "Asia/Shanghai", "daily_reflection"],
    ]);
  });

  it("keeps stable ids, job ids, and task construction rules for every alarm", () => {
    const alarmIds = new Set(FIXED_CEREBELLUM_ALARM_RULES.map((item) => item.alarmId));
    const jobIds = new Set(FIXED_CEREBELLUM_ALARM_RULES.map((item) => item.jobId));
    const tasks = FIXED_CEREBELLUM_ALARM_RULES.map((rule) =>
      buildCerebellumAlarmTask({
        alarm: rule,
        scheduledAt: "2026-06-12T00:00:00.000Z",
        sources: [
          {
            sourceId: `source-${rule.alarmId}`,
            category: "reports",
            relativePath: `memory/reports/2026-06-12/${rule.alarmId}.json`,
            summary: "Metadata summary only.",
          },
        ],
      }),
    );

    expect(alarmIds.size).toBe(FIXED_CEREBELLUM_ALARM_RULES.length);
    expect(jobIds.size).toBe(FIXED_CEREBELLUM_ALARM_RULES.length);
    expect(tasks).toHaveLength(17);
    expect(tasks.every((task) => task.taskType === "cerebellum_alarm")).toBe(true);
    expect(tasks.every((task) => task.status === "planned")).toBe(true);
    expect(tasks.every((task) => task.wakeBrain === true)).toBe(true);
    expect(tasks.every((task) => task.executionGuard.toolExecutionAllowed === false)).toBe(true);
    expect(tasks.every((task) => task.executionGuard.brokerSubmissionAllowed === false)).toBe(true);
    expect(tasks.every((task) => task.executionGuard.accountWriteAllowed === false)).toBe(true);
    expect(tasks.every((task) => task.executionGuard.liveTradingAllowed === false)).toBe(true);
    expect(
      tasks.every((task) => task.contextPackage.sop.requiredInputs.length > 0),
    ).toBe(true);
    expect(
      tasks.every((task) => task.contextPackage.sop.forbiddenActions.length > 0),
    ).toBe(true);
  });

  it("builds deterministic SOP templates for every fixed alarm without fake market facts", () => {
    const sops = FIXED_CEREBELLUM_ALARM_RULES.map((rule) => ({
      alarmType: rule.alarmType,
      sop: buildCerebellumAlarmSop(rule),
    }));

    expect(sops).toHaveLength(FIXED_CEREBELLUM_ALARM_RULES.length);

    for (const { sop } of sops) {
      expect(sop.objective).toEqual(expect.any(String));
      expect(sop.wakeRule).toMatch(/唤醒|闹钟/);
      expect(sop.operationInstructions.length).toBeGreaterThanOrEqual(3);
      expect(sop.requiredInputs.length).toBeGreaterThan(0);
      expect(sop.allowedActions.length).toBeGreaterThan(0);
      expect(sop.forbiddenActions.length).toBeGreaterThan(0);
      expect(sop.safetyConstraints.length).toBeGreaterThan(0);

      for (const input of sop.requiredInputs) {
        expect(Object.keys(input).sort()).toEqual([
          "category",
          "inputId",
          "metadata",
          "relativePath",
          "summary",
        ]);
        expect(input.relativePath).not.toMatch(/secret|credential|\.env/i);
        expect(input.summary).toEqual(expect.any(String));
      }
    }

    const serialized = JSON.stringify(sops);
    expect(serialized).not.toContain("000636");
    expect(serialized).not.toContain("风华高科");
    expect(serialized).not.toContain("sk-test-secret");
    expect(serialized).not.toMatch(/\b[036]\d{5}\b/);

    const rendered = renderCerebellumAlarmSop(sops[0]!.sop);
    expect(rendered).toContain("唤醒规则：");
    expect(rendered).toContain("操作指令：");
    expect(rendered).toMatch(/\n1\. /);
  });

  it("evaluates weekday and daily alarms in Beijing time", () => {
    const preMarket = alarm("pre_market_plan");
    const dailyReflection = alarm("daily_reflection");

    expect(isCerebellumAlarmDue(preMarket, "2026-06-12T00:30:00.000Z")).toBe(true);
    expect(isCerebellumAlarmDue(preMarket, "2026-06-13T00:30:00.000Z")).toBe(false);
    expect(isCerebellumAlarmDue(dailyReflection, "2026-06-11T16:00:00.000Z")).toBe(true);
    expect(toCerebellumBeijingTime("2026-06-11T16:00:00.000Z")).toMatchObject({
      timezone: "Asia/Shanghai",
      date: "2026-06-12",
      time: "00:00:00",
      dayOfWeek: 5,
    });
  });

  it("evaluates all weekday R2-1 intraday alarms in Beijing time", () => {
    const weekdayChecks: Array<[string, string]> = [
      ["2026-06-12T00:00:00.000Z", "data_warmup"],
      ["2026-06-12T00:15:00.000Z", "overnight_digest"],
      ["2026-06-12T00:30:00.000Z", "pre_market_plan"],
      ["2026-06-12T01:15:00.000Z", "call_auction_watch"],
      ["2026-06-12T01:25:00.000Z", "pre_open_confirmation"],
      ["2026-06-12T02:00:00.000Z", "morning_review"],
      ["2026-06-12T03:30:00.000Z", "midday_review"],
      ["2026-06-12T06:00:00.000Z", "afternoon_risk_scan"],
      ["2026-06-12T06:30:00.000Z", "late_session_plan"],
      ["2026-06-12T07:00:00.000Z", "closing_snapshot"],
      ["2026-06-12T07:30:00.000Z", "post_close_review"],
      ["2026-06-12T12:30:00.000Z", "deep_review"],
      ["2026-06-12T13:00:00.000Z", "next_day_watchlist"],
    ];

    for (const [now, expectedType] of weekdayChecks) {
      expect(getDueCerebellumAlarms({ now }).map(type)).toEqual([expectedType]);
    }
  });

  it("evaluates weekly, month-end, leap-year month-end, and year-end alarms", () => {
    expect(getDueCerebellumAlarms({ now: "2026-06-13T02:00:00.000Z" }).map(type)).toEqual([
      "weekly_review",
    ]);
    expect(getDueCerebellumAlarms({ now: "2026-06-29T12:00:00.000Z" }).map(type)).toEqual([]);
    expect(getDueCerebellumAlarms({ now: "2026-06-30T12:00:00.000Z" }).map(type)).toEqual([
      "monthly_review",
    ]);
    expect(getDueCerebellumAlarms({ now: "2028-02-29T12:00:00.000Z" }).map(type)).toEqual([
      "monthly_review",
    ]);
    expect(getDueCerebellumAlarms({ now: "2026-12-31T12:00:00.000Z" }).map(type)).toEqual([
      "monthly_review",
      "yearly_review",
    ]);
  });
});

describe("cerebellum context package", () => {
  it("builds metadata-only context packages and redacts secrets", () => {
    const expectedSop = buildCerebellumAlarmSop(alarm("pre_market_plan"));
    const task = buildCerebellumAlarmTask({
      alarm: alarm("pre_market_plan"),
      scheduledAt: "2026-06-12T00:30:00.000Z",
      sources: [
        {
          sourceId: "rules-risk",
          category: "rules",
          relativePath: "memory/rules/risk.md",
          title: "Risk rules",
          summary: "Use policy references only. token=abc123 account=paper-main",
          metadata: {
            apiKey: "sk-test-secret-123456",
            accountId: "paper-main",
            nested: {
              password: "plain-text",
              safe: "kept",
            },
          },
        },
      ],
      metadata: {
        secret: "do-not-keep",
        accountId: "paper-main",
        safeFlag: true,
      },
    });

    expect(task).toMatchObject({
      taskType: "cerebellum_alarm",
      alarmType: "pre_market_plan",
      brainTaskType: "pre_market_plan",
      wakeBrain: true,
      executionGuard: {
        toolExecutionAllowed: false,
        brokerSubmissionAllowed: false,
        accountWriteAllowed: false,
        liveTradingAllowed: false,
      },
      contextPackage: {
        beijingTime: {
          timezone: "Asia/Shanghai",
          date: "2026-06-12",
          time: "08:30:00",
        },
        sources: [
          {
            relativePath: "memory/rules/risk.md",
            summary: "Use policy references only. token=[redacted] account=[redacted]",
            metadata: {
              apiKey: "[redacted]",
              accountId: "[redacted]",
              nested: {
                password: "[redacted]",
                safe: "kept",
              },
            },
          },
        ],
        metadata: {
          secret: "[redacted]",
          accountId: "[redacted]",
          safeFlag: true,
          liveTrading: false,
          brokerConnected: false,
          directExecutionAllowed: false,
        },
        sop: expectedSop,
      },
    });
    expect(JSON.stringify(task)).not.toContain("sk-test-secret");
    expect(JSON.stringify(task)).not.toContain("plain-text");
    expect(JSON.stringify(task)).not.toContain("paper-main");
  });

  it("rejects context sources that point at secrets", () => {
    expect(() =>
      buildCerebellumAlarmTask({
        alarm: alarm("daily_reflection"),
        scheduledAt: "2026-06-11T16:00:00.000Z",
        sources: [
          {
            sourceId: "bad-secret",
            category: "config",
            relativePath: "memory/secrets/openai.md",
            summary: "must not be accepted",
          },
        ],
      }),
    ).toThrow("Context source path must not reference secrets");
  });
});

function alarm(alarmType: (typeof FIXED_CEREBELLUM_ALARM_RULES)[number]["alarmType"]) {
  const rule = FIXED_CEREBELLUM_ALARM_RULES.find((item) => item.alarmType === alarmType);

  if (!rule) {
    throw new Error(`Missing alarm ${alarmType}`);
  }

  return rule;
}

function type(alarmRule: (typeof FIXED_CEREBELLUM_ALARM_RULES)[number]) {
  return alarmRule.alarmType;
}
