import { DEFAULT_TV_TUNING_DELAYS, type TvTuningDelays } from "./tv-channels.js";

export interface AppConfig {
  discordToken: string;
  guildId: string;
  watchUserId: string;
  mentionUserId: string;
  incidentChannelId: string;
  debounceMs: number;
  tvtestApiUrl: string | null;
  tvtestBonDrivers: string[];
  tvtestTuningDelays: TvTuningDelays;
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function parseDebounceMs(rawValue: string | undefined): number {
  if (!rawValue || rawValue.trim() === "") {
    return 15000;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("DEBOUNCE_MS must be a positive integer");
  }

  return parsed;
}

function parseBonDrivers(rawValue: string | undefined): string[] {
  if (!rawValue || rawValue.trim() === "") return [];
  return rawValue
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseNonNegativeInt(
  rawValue: string | undefined,
  defaultValue: number,
  envName: string,
): number {
  if (!rawValue || rawValue.trim() === "") {
    return defaultValue;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${envName} must be a non-negative integer`);
  }

  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const watchUserId = requireEnv(env, "WATCH_USER_ID");
  const mentionUserId = env.MENTION_USER_ID?.trim() || watchUserId;

  return {
    discordToken: requireEnv(env, "DISCORD_TOKEN"),
    guildId: requireEnv(env, "GUILD_ID"),
    watchUserId,
    mentionUserId,
    incidentChannelId: requireEnv(env, "INCIDENT_CHANNEL_ID"),
    debounceMs: parseDebounceMs(env.DEBOUNCE_MS),
    tvtestApiUrl: env.TVTEST_API_URL?.trim() || null,
    tvtestBonDrivers: parseBonDrivers(env.TVTEST_BON_DRIVERS),
    tvtestTuningDelays: {
      postDriverSwitchDelayMs: parseNonNegativeInt(
        env.TVTEST_POST_DRIVER_SWITCH_DELAY_MS,
        DEFAULT_TV_TUNING_DELAYS.postDriverSwitchDelayMs,
        "TVTEST_POST_DRIVER_SWITCH_DELAY_MS",
      ),
      postChannelChangeDelayMs: parseNonNegativeInt(
        env.TVTEST_POST_CHANNEL_CHANGE_DELAY_MS,
        DEFAULT_TV_TUNING_DELAYS.postChannelChangeDelayMs,
        "TVTEST_POST_CHANNEL_CHANGE_DELAY_MS",
      ),
    },
  };
}
