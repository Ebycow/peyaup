export interface AppConfig {
  discordToken: string;
  guildId: string;
  watchUserId: string;
  mentionUserId: string;
  incidentChannelId: string;
  debounceMs: number;
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
  };
}
