import { ConfigLoadError } from "./errors.js";

export type EnvMap = Record<string, string | undefined>;

export function parseDotEnv(source: string): Record<string, string> {
  const values: Record<string, string> = {};

  source.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      return;
    }

    const normalizedLine = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = normalizedLine.indexOf("=");

    if (separatorIndex <= 0) {
      throw new ConfigLoadError(`Invalid .env line ${index + 1}: expected KEY=value`);
    }

    const key = normalizedLine.slice(0, separatorIndex).trim();
    const rawValue = normalizedLine.slice(separatorIndex + 1).trim();

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new ConfigLoadError(`Invalid .env key "${key}" on line ${index + 1}`);
    }

    values[key] = parseEnvValue(rawValue);
  });

  return values;
}

export function mergeEnvMaps(...maps: EnvMap[]): Record<string, string> {
  const merged: Record<string, string> = {};

  for (const map of maps) {
    for (const [key, value] of Object.entries(map)) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }
  }

  return merged;
}

export function readBooleanEnv(env: EnvMap, key: string): boolean | undefined {
  const value = readStringEnv(env, key);

  if (value === undefined) {
    return undefined;
  }

  const normalized = value.toLowerCase();

  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  throw new ConfigLoadError(`Invalid boolean env ${key}="${value}"`);
}

export function readNumberEnv(env: EnvMap, key: string): number | undefined {
  const value = readStringEnv(env, key);

  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new ConfigLoadError(`Invalid number env ${key}="${value}"`);
  }

  return parsed;
}

export function readStringEnv(env: EnvMap, key: string): string | undefined {
  const value = env[key];

  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return unquote(value);
  }

  return stripInlineComment(value);
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function stripInlineComment(value: string): string {
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    }

    if (char === "#" && !inSingleQuote && !inDoubleQuote) {
      const previous = value[index - 1];

      if (previous === undefined || /\s/.test(previous)) {
        return value.slice(0, index).trim();
      }
    }
  }

  return value.trim();
}
