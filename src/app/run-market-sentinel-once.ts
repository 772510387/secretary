import {
  checkMarketSentinel,
  type MarketSentinelCheckInput,
  type MarketSentinelCheckResult,
} from "../domain/cerebellum/index.js";

export function runMarketSentinelOnce(
  input: MarketSentinelCheckInput,
): MarketSentinelCheckResult {
  return checkMarketSentinel(input);
}

