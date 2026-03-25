import { loadConfig, type AppConfig } from "./config.js";
import {
  createDiscordClient,
  fetchWatchState,
  getSpinCommandPayloads,
  handleSpinInteraction,
  handleTvCommandInteraction,
  notifyIncident,
  snapshotFromVoiceState,
} from "./discord.js";
import { createLogger } from "./logger.js";
import { StreamMonitor } from "./monitor.js";
import {
  syncSlashCommandScope,
  type SlashCommandPayload,
} from "./slash-command-registration.js";
import { discoverAllChannels } from "./tv-channels.js";
import { buildTvCommandPayload, type TvCommandContext } from "./tv-commands.js";

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

// TVTEST_API_URL が設定されている場合のみ TV 機能を有効化
const tvCtx: TvCommandContext | null =
  config.tvtestApiUrl !== null
    ? {
        baseUrl: config.tvtestApiUrl,
        bonDrivers: config.tvtestBonDrivers,
        tuningDelays: config.tvtestTuningDelays,
        channels: [],
      }
    : null;

client.once("ready", () => {
  void (async () => {
    logger.info(`Logged in as ${client.user?.tag ?? "unknown"}.`);

    const guildCommandPayloads: SlashCommandPayload[] = [...getSpinCommandPayloads()];
    if (tvCtx !== null) {
      guildCommandPayloads.push(buildTvCommandPayload());
    }

    try {
      const guild = await client.guilds.fetch(config.guildId);
      await syncSlashCommandScope(
        {
          fetchExistingCommands: () => guild.commands.fetch(),
          replaceCommands: (payloads) => guild.commands.set(payloads),
          scopeLabel: `guild ${config.guildId}`,
        },
        guildCommandPayloads,
        logger,
      );
    } catch (error) {
      logger.error("Failed to sync guild slash commands.", error);
    }

    try {
      const application = client.application;
      if (!application) {
        throw new Error("Discord application is unavailable after ready.");
      }

      await syncSlashCommandScope(
        {
          fetchExistingCommands: () => application.commands.fetch(),
          replaceCommands: (payloads) => application.commands.set(payloads),
          scopeLabel: "global",
        },
        [],
        logger,
      );
    } catch (error) {
      logger.error("Failed to sync global slash commands.", error);
    }

    if (tvCtx !== null) {
      try {
        const discovered = await discoverAllChannels(
          tvCtx.baseUrl,
          tvCtx.bonDrivers,
          logger,
          tvCtx.tuningDelays,
        );
        tvCtx.channels.push(...discovered);
        logger.info(`TV channel discovery complete: ${discovered.length} channels loaded.`);
      } catch (error) {
        logger.warn("TV channel discovery failed. /tv channel autocomplete will be empty.", error);
      }
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
  if (tvCtx !== null) {
    void handleTvCommandInteraction(interaction, tvCtx, logger);
  }
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
