import type { AuditEvent } from "../../domain/audit/index.js";
import {
  notificationDeliveryResultSchema,
  notificationEventSchema,
  planNotificationRoute,
  redactNotificationText,
  type EvaluateNotificationPolicyOptions,
  type NotificationChannel,
  type NotificationDeliveryResult,
  type NotificationEvent,
  type NotificationPolicyState,
  type NotificationRouteConfig,
  type NotificationRoutePlan,
} from "../../domain/notification/index.js";
import type {
  ExternalNotificationNotifier,
  NotificationNotifier,
} from "./notifier.js";

export type NotificationAuditSink = (event: AuditEvent) => void | Promise<void>;
export type NotificationRouteAuditStatus = "not_required" | "written" | "failed";
export type NotificationRouterDispatchStatus = "sent" | "skipped" | "failed";
export type NotificationRouterNotifier = NotificationNotifier | ExternalNotificationNotifier;
export type NotificationRouterNotifierMap = Partial<Record<NotificationChannel, NotificationRouterNotifier>>;

export interface NotificationRouterOptions extends EvaluateNotificationPolicyOptions {
  notifiers?: NotificationRouterNotifierMap;
  auditSink?: NotificationAuditSink;
  state?: Partial<NotificationPolicyState>;
  routeConfig?: Partial<NotificationRouteConfig>;
  now?: Date | string;
}

export interface NotificationRouterDispatchResult {
  status: NotificationRouterDispatchStatus;
  plan: NotificationRoutePlan;
  deliveries: NotificationDeliveryResult[];
  auditEvent?: AuditEvent;
  auditStatus: NotificationRouteAuditStatus;
  errors: string[];
  nextState: NotificationPolicyState;
}

export class NotificationRouter {
  private readonly notifiers: NotificationRouterNotifierMap;
  private readonly auditSink: NotificationAuditSink | undefined;
  private readonly options: Omit<NotificationRouterOptions, "notifiers" | "auditSink" | "state">;
  private state: NotificationPolicyState | undefined;

  constructor(options: NotificationRouterOptions = {}) {
    this.notifiers = options.notifiers ?? {};
    this.auditSink = options.auditSink;
    this.state = options.state as NotificationPolicyState | undefined;
    this.options = {
      routeConfig: options.routeConfig,
      now: options.now,
      dedupeWindowMs: options.dedupeWindowMs,
      cooldownMs: options.cooldownMs,
      criticalBypassesCooldown: options.criticalBypassesCooldown,
    };
  }

  getState(): NotificationPolicyState | undefined {
    return this.state;
  }

  async notify(eventInput: NotificationEvent): Promise<NotificationRouterDispatchResult> {
    const event = notificationEventSchema.parse(eventInput);
    const plan = planNotificationRoute(event, this.state ?? {}, this.options);
    this.state = plan.nextState;

    if (plan.status !== "send") {
      return {
        status: "skipped",
        plan,
        deliveries: [],
        auditEvent: plan.auditEvent,
        auditStatus: "not_required",
        errors: [],
        nextState: plan.nextState,
      };
    }

    const auditResult = await this.writeCriticalAudit(plan);

    if (auditResult.status === "failed") {
      return {
        status: "failed",
        plan,
        deliveries: [],
        auditEvent: plan.auditEvent,
        auditStatus: "failed",
        errors: [auditResult.error ?? "critical_notification_audit_failed"],
        nextState: plan.nextState,
      };
    }

    const deliveries: NotificationDeliveryResult[] = [];
    const errors: string[] = [];

    for (const channel of plan.channels) {
      const notifier = this.notifiers[channel];

      if (notifier === undefined) {
        const missing = failedDelivery(
          plan.event,
          channel,
          `notification_notifier_not_configured: ${channel}`,
          this.isoNow(),
        );
        deliveries.push(missing);
        errors.push(missing.error!);
        continue;
      }

      try {
        deliveries.push(await notifyOne(notifier, {
          ...plan.event,
          channels: [channel],
        }));
      } catch (error) {
        const failed = failedDelivery(
          plan.event,
          channel,
          `notification_notifier_failed: ${error instanceof Error ? error.message : String(error)}`,
          this.isoNow(),
        );
        deliveries.push(failed);
        errors.push(failed.error!);
      }
    }

    return {
      status: errors.length > 0 ? "failed" : "sent",
      plan,
      deliveries,
      auditEvent: plan.auditEvent,
      auditStatus: auditResult.status,
      errors,
      nextState: plan.nextState,
    };
  }

  private async writeCriticalAudit(plan: NotificationRoutePlan): Promise<{
    status: NotificationRouteAuditStatus;
    error?: string;
  }> {
    if (plan.auditEvent === undefined) {
      return {
        status: "not_required",
      };
    }

    if (this.auditSink === undefined) {
      return {
        status: "failed",
        error: "critical_notification_audit_sink_not_configured",
      };
    }

    try {
      await this.auditSink(plan.auditEvent);

      return {
        status: "written",
      };
    } catch (error) {
      return {
        status: "failed",
        error: redactNotificationText(
          `critical_notification_audit_write_failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      };
    }
  }

  private isoNow(): string {
    const now = this.options.now instanceof Date || typeof this.options.now === "string"
      ? new Date(this.options.now)
      : new Date();

    if (Number.isNaN(now.getTime())) {
      throw new NotificationRouterError("NotificationRouter now option is invalid");
    }

    return now.toISOString();
  }
}

async function notifyOne(
  notifier: NotificationRouterNotifier,
  event: NotificationEvent,
): Promise<NotificationDeliveryResult> {
  return notificationDeliveryResultSchema.parse(await Promise.resolve(notifier.notify(event)));
}

function failedDelivery(
  event: NotificationEvent,
  channel: NotificationChannel,
  error: string,
  deliveredAt: string,
): NotificationDeliveryResult {
  return notificationDeliveryResultSchema.parse({
    eventId: event.eventId,
    channel,
    status: "failed",
    deliveredAt,
    error: redactNotificationText(error).slice(0, 1000),
  });
}

export class NotificationRouterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotificationRouterError";
  }
}
