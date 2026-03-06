import {
  Client,
  GatewayIntentBits,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Interaction,
  type VoiceState,
} from "discord.js";
import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { VoiceStateSnapshot } from "./monitor.js";
import {
  SLOT_COLUMNS,
  calculateWinProbability,
  createRevealGrid,
  createSlotGrid,
  findWinningPaylines,
  formatProbabilityPercent,
  formatSlotGrid,
} from "./spin.js";

const SPIN_COMMAND_NAME = "spin";
const SPIN_RATE_COMMAND_NAME = "spin-rate";
const SPIN_REVEAL_DELAY_MS = 1000;
const SPIN_COMMAND_PAYLOADS = [
  {
    name: SPIN_COMMAND_NAME,
    description: "ギルド絵文字で3x3スロットを回す",
  },
  {
    name: SPIN_RATE_COMMAND_NAME,
    description: "このサーバーでの /spin 当選確率を表示する",
  },
] as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function renderSpinMessage(gridText: string, celebrationText?: string): string {
  if (!celebrationText) {
    return gridText;
  }

  return `${gridText}\n\n${celebrationText}`;
}

export function createDiscordClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
}

function snapshotFromMember(member: GuildMember): VoiceStateSnapshot {
  return {
    guildId: member.guild.id,
    userId: member.id,
    channelId: member.voice.channelId,
    streaming: Boolean(member.voice.streaming),
  };
}

export function snapshotFromVoiceState(state: VoiceState): VoiceStateSnapshot {
  return {
    guildId: state.guild.id,
    userId: state.id,
    channelId: state.channelId,
    streaming: Boolean(state.streaming),
  };
}

export async function fetchWatchState(client: Client, config: AppConfig): Promise<VoiceStateSnapshot> {
  const guild = await client.guilds.fetch(config.guildId);
  const member = await guild.members.fetch(config.watchUserId).catch(() => null);

  if (!member) {
    throw new Error(`Watch user ${config.watchUserId} was not found in guild ${config.guildId}`);
  }

  return snapshotFromMember(member);
}

export async function notifyIncident(client: Client, config: AppConfig): Promise<void> {
  const channel = await client.channels.fetch(config.incidentChannelId);
  if (!channel) {
    throw new Error(`Incident channel ${config.incidentChannelId} could not be fetched`);
  }

  if (!channel.isTextBased() || !channel.isSendable()) {
    throw new Error(`Incident channel ${config.incidentChannelId} is not sendable`);
  }

  if ("guildId" in channel && channel.guildId !== null && channel.guildId !== config.guildId) {
    throw new Error(
      `Incident channel guild mismatch. Expected guild ${config.guildId}, got ${channel.guildId}`,
    );
  }

  await channel.send({
    content: `🚨 <@${config.mentionUserId}> <@${config.watchUserId}>のライブ配信が停止したよ！`,
    allowedMentions: {
      parse: [],
      users: [config.mentionUserId],
    },
  });
}

export async function registerSpinCommands(client: Client, guildId: string, logger: Logger): Promise<void> {
  const guild = await client.guilds.fetch(guildId);
  const guildCommands = await guild.commands.fetch();
  for (const payload of SPIN_COMMAND_PAYLOADS) {
    const existing = guildCommands.find((command) => command.name === payload.name);

    if (existing) {
      await guild.commands.edit(existing.id, payload);
      logger.info(`Guild slash command /${payload.name} updated for guild ${guildId}.`);
      continue;
    }

    await guild.commands.create(payload);
    logger.info(`Guild slash command /${payload.name} created for guild ${guildId}.`);
  }

}

async function executeSpin(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply({
      content: "このコマンドはサーバー内でのみ利用できます。",
      ephemeral: true,
    });
    return;
  }

  const guild = interaction.guild ?? (await interaction.client.guilds.fetch(interaction.guildId));
  const emojis = await guild.emojis.fetch();
  const emojiPool = emojis.map((emoji) => emoji.toString());

  if (emojiPool.length === 0) {
    await interaction.reply({
      content: "このギルドにはカスタム絵文字がないため /spin を実行できません。",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: false });

  const finalGrid = createSlotGrid(emojiPool);
  await interaction.editReply({
    content: renderSpinMessage(formatSlotGrid(createRevealGrid(finalGrid, 0))),
  });

  for (let revealedColumns = 1; revealedColumns <= SLOT_COLUMNS; revealedColumns += 1) {
    await delay(SPIN_REVEAL_DELAY_MS);

    await interaction.editReply({
      content: renderSpinMessage(formatSlotGrid(createRevealGrid(finalGrid, revealedColumns))),
    });
  }

  const winners = findWinningPaylines(finalGrid);
  const celebrationMessage = winners.length > 0 ? "🎉 おめでとう！当たり！" : undefined;

  await interaction.editReply({
    content: renderSpinMessage(formatSlotGrid(finalGrid), celebrationMessage),
  });
}

async function executeSpinRate(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply({
      content: "このコマンドはサーバー内でのみ利用できます。",
      ephemeral: true,
    });
    return;
  }

  const guild = interaction.guild ?? (await interaction.client.guilds.fetch(interaction.guildId));
  const emojis = await guild.emojis.fetch();
  const emojiCount = emojis.size;

  if (emojiCount === 0) {
    await interaction.reply({
      content: "このギルドにはカスタム絵文字がないため、当選確率を計算できません。",
      ephemeral: true,
    });
    return;
  }

  const probability = calculateWinProbability(emojiCount);
  const percentage = formatProbabilityPercent(probability, 4);

  await interaction.reply({
    content: `このサーバーでの /spin 当選確率は **${percentage}** です。（絵文字 ${emojiCount} 個・3x3・8ライン判定）`,
  });
}

export async function handleSpinInteraction(interaction: Interaction, logger: Logger): Promise<void> {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (interaction.commandName !== SPIN_COMMAND_NAME && interaction.commandName !== SPIN_RATE_COMMAND_NAME) {
    return;
  }

  try {
    if (interaction.commandName === SPIN_COMMAND_NAME) {
      await executeSpin(interaction);
      return;
    }

    await executeSpinRate(interaction);
  } catch (error) {
    logger.error(`Failed to execute /${interaction.commandName}.`, error);

    const errorMessage =
      interaction.commandName === SPIN_RATE_COMMAND_NAME
        ? "当選確率の取得中にエラーが発生しました。時間をおいて再度お試しください。"
        : "スロットの実行中にエラーが発生しました。時間をおいて再度お試しください。";
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: errorMessage });
      } else {
        await interaction.reply({ content: errorMessage, ephemeral: true });
      }
    } catch (replyError) {
      logger.error("Failed to send /spin error response.", replyError);
    }
  }
}
