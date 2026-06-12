import {
  AlarmJobRegistry,
  BeijingClock,
  GracefulShutdown,
  JobLock,
  MarketSentinelRunner,
  type AlarmJobRegistryOptions,
  type Clock,
  type MarketSentinelRunnerOptions,
} from "../infrastructure/scheduler/index.js";

export interface SchedulerRuntimeOptions {
  clock?: Clock;
  lock?: JobLock;
  shutdown?: GracefulShutdown;
}

export interface SchedulerRuntime {
  clock: BeijingClock;
  lock: JobLock;
  alarms: AlarmJobRegistry;
  shutdown: GracefulShutdown;
  createMarketSentinelRunner(
    options: Omit<MarketSentinelRunnerOptions, "clock" | "lock" | "signal">,
  ): MarketSentinelRunner;
}

export function createSchedulerRuntime(options: SchedulerRuntimeOptions = {}): SchedulerRuntime {
  const clock = new BeijingClock(options.clock);
  const lock = options.lock ?? new JobLock({ clock });
  const shutdown = options.shutdown ?? new GracefulShutdown();
  const alarmOptions: AlarmJobRegistryOptions = {
    clock,
    lock,
    signal: shutdown.signal,
  };
  const alarms = new AlarmJobRegistry(alarmOptions);

  return {
    clock,
    lock,
    alarms,
    shutdown,
    createMarketSentinelRunner(runnerOptions) {
      const runner = new MarketSentinelRunner({
        ...runnerOptions,
        clock,
        lock,
        signal: shutdown.signal,
      });

      shutdown.register(`runner:${runnerOptions.jobId ?? "market-sentinel"}`, () => runner.stop());
      return runner;
    },
  };
}
