import { loadConfig, type AppConfig } from "./config.js";
import {
  createDiscordClient,
  fetchWatchState,
  handleSpinInteraction,
  notifyIncident,
  registerSpinCommands,
  snapshotFromVoiceState,
} from "./discord.js";
import { createLogger } from "./logger.js";
import { StreamMonitor } from "./monitor.js";

const logger = createLogger();

function loadConfigOrExit(): AppConfig {
  try {
    return loadConfig();
  } catch (error) {
    logger.error("Configuration error. Exiting.", error);
    process.exit(1);
  }
}

const config = loadConfigOrExit();
const client = createDiscordClient();

const monitor = new StreamMonitor({
  guildId: config.guildId,
  watchUserId: config.watchUserId,
  debounceMs: config.debounceMs,
  logger,
  fetchCurrentState: () => fetchWatchState(client, config),
  notifyIncident: () => notifyIncident(client, config),
});

client.once("ready", () => {
  void (async () => {
    logger.info(`Logged in as ${client.user?.tag ?? "unknown"}.`);

    try {
      await registerSpinCommands(client, config.guildId, logger);
    } catch (error) {
      logger.error("Failed to register spin commands.", error);
    }

    try {
      await monitor.initialize();
      logger.info("Stream monitor is running.");
    } catch (error) {
      logger.error("Startup check failed. Exiting.", error);
      await client.destroy();
      process.exit(1);
    }
  })();
});

client.on("interactionCreate", (interaction) => {
  void handleSpinInteraction(interaction, logger);
});

client.on("voiceStateUpdate", (oldState, newState) => {
  const oldSnapshot = snapshotFromVoiceState(oldState);
  const newSnapshot = snapshotFromVoiceState(newState);
  void monitor.onVoiceStateUpdate(oldSnapshot, newSnapshot);
});

client.on("error", (error) => {
  logger.error("Discord client error.", error);
});

async function shutdown(signal: string): Promise<void> {
  logger.info(`${signal} received. Shutting down.`);
  await client.destroy();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

client.login(config.discordToken).catch((error) => {
  logger.error("Failed to login to Discord.", error);
  process.exit(1);
});
