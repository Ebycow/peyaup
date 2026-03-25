import {
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  type Interaction,
  SlashCommandBuilder,
} from "discord.js";
import type { Logger } from "./logger.js";
import {
  buildChannelChoiceLabel,
  discoverAllChannels,
  encodeChannelSelectionValue,
  findChannel,
  getCurrentChannel,
  searchAllChannels,
  searchChannels,
  summarizeChannelsByNetwork,
  tuneToChannel,
  type TvTuningDelays,
  type UnifiedChannel,
} from "./tv-channels.js";
import { tvGetStatus } from "./tvtest.js";

const TV_COMMAND_NAME = "tv";
const SUBCOMMAND_CHANNEL = "channel";
const SUBCOMMAND_LIST = "list";
const SUBCOMMAND_STATUS = "status";
const SUBCOMMAND_RELOAD = "reload";
const CHANNEL_LIST_PAGE_SIZE = 15;

export interface TvCommandContext {
  baseUrl: string;
  /** 走査対象の BonDriver ファイル名リスト (TVTEST_BON_DRIVERS) */
  bonDrivers: string[];
  /** BonDriver 切替・選局まわりの待機設定 */
  tuningDelays: TvTuningDelays;
  channels: UnifiedChannel[];
}

export function buildTvCommandPayload(): RESTPostAPIChatInputApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName(TV_COMMAND_NAME)
    .setDescription("TVTest のチャンネルを操作する")
    .addSubcommand((sub) =>
      sub
        .setName(SUBCOMMAND_CHANNEL)
        .setDescription("チャンネルを変更する")
        .addStringOption((opt) =>
          opt
            .setName("name")
            .setDescription("チャンネル名（入力で候補を絞り込めます）")
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName(SUBCOMMAND_LIST)
        .setDescription("チャンネル一覧を表示する")
        .addStringOption((opt) =>
          opt
            .setName("query")
            .setDescription("チャンネル名やネットワーク名で絞り込む")
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("page")
            .setDescription("表示するページ番号")
            .setMinValue(1)
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName(SUBCOMMAND_STATUS).setDescription("現在視聴中のチャンネルと番組情報を表示する"),
    )
    .addSubcommand((sub) =>
      sub.setName(SUBCOMMAND_RELOAD).setDescription("チャンネル一覧を再スキャンする"),
    )
    .toJSON();
}

export function handleTvAutocomplete(interaction: AutocompleteInteraction, ctx: TvCommandContext): void {
  const focused = interaction.options.getFocused();
  const matches = searchChannels(ctx.channels, focused);
  const duplicateBaseLabels = getDuplicateBaseLabels(ctx.channels);

  void interaction.respond(
    matches.map((ch) => ({
      name: buildChannelChoiceLabel(ch, duplicateBaseLabels),
      value: encodeChannelSelectionValue(ch),
    })),
  );
}

async function executeChannelChange(
  interaction: ChatInputCommandInteraction,
  ctx: TvCommandContext,
  logger: Logger,
): Promise<void> {
  const query = interaction.options.getString("name", true);
  const target = findChannel(ctx.channels, query);

  if (!target) {
    await interaction.reply({
      content: `チャンネル「${query}」が見つかりませんでした。\`/tv reload\` でチャンネル一覧を更新してから再度お試しください。`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  try {
    const result = await tuneToChannel(ctx.baseUrl, target, ctx.tuningDelays);
    const reportedChannelName = result.status.channel?.name?.trim() ?? "";
    const channelMismatch = reportedChannelName !== "" && !isSameChannelName(target.displayName, reportedChannelName);
    const programNote = result.statusConfirmed
      ? result.status.program?.name
        ? `\n番組: ${result.status.program.name}`
        : ""
      : !channelMismatch
        ? "\n番組情報は更新待ちです。"
        : `\n> 現在の状態では **${reportedChannelName}** が報告されています。チャンネル一覧が古い可能性があるため、\`/tv reload\` をお試しください。`;
    const driverNote = result.driverSwitched
      ? `\n> BonDriver を \`${target.driver}\` に切り替えました。`
      : "";

    await interaction.editReply({
      content: `📺 **${result.channel.displayName}** に切り替えました。${programNote}${driverNote}`,
    });
  } catch (error) {
    logger.error("Failed to change TV channel.", error);
    await interaction.editReply({
      content: "チャンネル変更中にエラーが発生しました。TVTest が起動しているか確認してください。",
    });
  }
}

async function executeStatus(
  interaction: ChatInputCommandInteraction,
  ctx: TvCommandContext,
  logger: Logger,
): Promise<void> {
  await interaction.deferReply();

  try {
    const [current, status] = await Promise.all([
      getCurrentChannel(ctx.baseUrl, ctx.channels),
      tvGetStatus(ctx.baseUrl),
    ]);
    const channelName = current?.displayName ?? status.channel?.name ?? "不明なチャンネル";
    const networkName = current?.networkName ?? status.channel?.networkName ?? "";

    const programName = status.program?.name || "（番組情報なし）";
    const programText = status.program?.text ? `\n${status.program.text}` : "";

    await interaction.editReply({
      content: `📺 **${channelName}**${networkName ? ` (${networkName})` : ""}\n番組: ${programName}${programText}`,
    });
  } catch (error) {
    logger.error("Failed to get TV status.", error);
    await interaction.editReply({
      content: "ステータス取得中にエラーが発生しました。TVTest が起動しているか確認してください。",
    });
  }
}

async function executeList(
  interaction: ChatInputCommandInteraction,
  ctx: TvCommandContext,
): Promise<void> {
  if (ctx.channels.length === 0) {
    await interaction.reply({
      content: "チャンネル一覧がまだ読み込まれていません。\`/tv reload\` で再スキャンしてください。",
      ephemeral: true,
    });
    return;
  }

  const query = interaction.options.getString("query")?.trim() ?? "";
  const requestedPage = interaction.options.getInteger("page") ?? 1;
  const matches = searchAllChannels(ctx.channels, query);

  if (matches.length === 0) {
    const content =
      query === ""
        ? "表示できるチャンネルがありません。\`/tv reload\` で一覧を更新してください。"
        : `「${query}」に一致するチャンネルはありませんでした。\`/tv list\` で全体を確認できます。`;
    await interaction.reply({ content, ephemeral: true });
    return;
  }

  const totalPages = Math.ceil(matches.length / CHANNEL_LIST_PAGE_SIZE);
  const page = Math.min(Math.max(requestedPage, 1), totalPages);
  const startIndex = (page - 1) * CHANNEL_LIST_PAGE_SIZE;
  const pageItems = matches.slice(startIndex, startIndex + CHANNEL_LIST_PAGE_SIZE);
  const duplicateBaseLabels = getDuplicateBaseLabels(matches);
  const summary = summarizeChannelsByNetwork(matches)
    .slice(0, 4)
    .map((entry) => `${entry.networkName} ${entry.count}`)
    .join(" / ");

  const title =
    query === ""
      ? `📺 チャンネル一覧 ${page}/${totalPages} (全${matches.length}件)`
      : `📺 チャンネル検索「${query}」 ${page}/${totalPages} (${matches.length}件)`;
  const pageNote =
    requestedPage !== page ? `\n> page:${requestedPage} は範囲外だったため ${page} ページ目を表示しています。` : "";
  const summaryNote = summary === "" ? "" : `\n分類: ${summary}`;
  const lines = pageItems.map((channel, index) => {
    const lineNumber = startIndex + index + 1;
    return `${lineNumber}. ${buildChannelChoiceLabel(channel, duplicateBaseLabels)}`;
  });
  const hint =
    query === ""
      ? "\n`/tv list page:2` で続きを表示できます。`/tv list query:J-SPORTS` のように絞り込みもできます。"
      : "\n候補が見つかったら `/tv channel` の autocomplete から選べます。";

  await interaction.reply({
    content: `${title}${summaryNote}${pageNote}\n${lines.join("\n")}${hint}`,
    ephemeral: true,
  });
}

async function executeReload(
  interaction: ChatInputCommandInteraction,
  ctx: TvCommandContext,
  logger: Logger,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const discovered = await discoverAllChannels(ctx.baseUrl, ctx.bonDrivers, logger, ctx.tuningDelays);
    ctx.channels.length = 0;
    ctx.channels.push(...discovered);

    await interaction.editReply({
      content: `チャンネル一覧を更新しました。${discovered.length} チャンネルを検出しました。`,
    });
  } catch (error) {
    logger.error("Failed to reload TV channels.", error);
    await interaction.editReply({
      content: "チャンネル再スキャン中にエラーが発生しました。TVTest が起動しているか確認してください。",
    });
  }
}

export async function handleTvInteraction(
  interaction: Interaction,
  ctx: TvCommandContext,
  logger: Logger,
): Promise<void> {
  if (interaction.isAutocomplete() && interaction.commandName === TV_COMMAND_NAME) {
    handleTvAutocomplete(interaction, ctx);
    return;
  }

  if (!interaction.isChatInputCommand() || interaction.commandName !== TV_COMMAND_NAME) {
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  try {
    if (subcommand === SUBCOMMAND_CHANNEL) {
      await executeChannelChange(interaction, ctx, logger);
    } else if (subcommand === SUBCOMMAND_LIST) {
      await executeList(interaction, ctx);
    } else if (subcommand === SUBCOMMAND_STATUS) {
      await executeStatus(interaction, ctx, logger);
    } else if (subcommand === SUBCOMMAND_RELOAD) {
      await executeReload(interaction, ctx, logger);
    }
  } catch (error) {
    logger.error(`Failed to execute /tv ${subcommand}.`, error);
    const msg = "エラーが発生しました。時間をおいて再度お試しください。";
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: msg });
      } else {
        await interaction.reply({ content: msg, ephemeral: true });
      }
    } catch (replyError) {
      logger.error("Failed to send /tv error response.", replyError);
    }
  }
}

function getDuplicateBaseLabels(channels: UnifiedChannel[]): Set<string> {
  const counts = new Map<string, number>();

  channels.forEach((channel) => {
    const label = buildChannelChoiceLabel(channel);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  });

  return new Set(
    Array.from(counts.entries())
      .filter(([, count]) => count > 1)
      .map(([label]) => label),
  );
}

function isSameChannelName(left: string, right: string): boolean {
  return normalizeChannelName(left) === normalizeChannelName(right);
}

function normalizeChannelName(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000\-‐‑‒–—―ーｰ_./・()（）[\]［］]+/g, "");
}
