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
  encodeChannelSelectionValue,
  findChannel,
  getCurrentChannel,
  searchChannels,
  summarizeChannelsByNetwork,
  tuneToChannel,
  type TvTuningDelays,
  type UnifiedChannel,
} from "./tv-channels.js";
import {
  tvGetProgramsForChannels,
  tvGetStatus,
  type TvTestChannelProgramResult,
} from "./tvtest.js";

const TV_COMMAND_NAME = "tv";
const SUBCOMMAND_CHANNEL = "channel";
const SUBCOMMAND_LIST = "list";
const SUBCOMMAND_STATUS = "status";
const CHANNEL_LIST_PAGE_SIZE = 15;
const AUTOCOMPLETE_RESULT_LIMIT = 25;
const CHANNEL_PROGRAM_CACHE_TTL_MS = 15000;
const AUTOCOMPLETE_CHOICE_NAME_LIMIT = 100;
const LIST_PROGRAM_NAME_LIMIT = 36;

interface CachedChannelProgram {
  expiresAtMs: number;
  result: TvTestChannelProgramResult;
}

interface SearchChannelsResult {
  matches: UnifiedChannel[];
  programs: Map<string, TvTestChannelProgramResult>;
}

interface RankedChannelWithProgram {
  channel: UnifiedChannel;
  score: number;
  index: number;
}

const channelProgramCache = new Map<string, CachedChannelProgram>();

export interface TvCommandContext {
  baseUrl: string;
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
            .setDescription("チャンネル名や番組名で候補を絞り込めます")
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
            .setDescription("チャンネル名・番組名・ネットワーク名で絞り込む")
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
    .toJSON();
}

export async function handleTvAutocomplete(
  interaction: AutocompleteInteraction,
  ctx: TvCommandContext,
  logger: Logger,
): Promise<void> {
  try {
    const focused = interaction.options.getFocused();
    const { matches, programs } = await searchChannelsForAutocomplete(ctx.baseUrl, ctx.channels, focused, logger);
    const duplicateBaseLabels = getDuplicateBaseLabels(ctx.channels);

    await interaction.respond(
      matches.map((ch) => ({
        name: buildAutocompleteChoiceName(
          ch,
          duplicateBaseLabels,
          programs.get(buildChannelProgramCacheKey(ctx.baseUrl, ch)),
        ),
        value: encodeChannelSelectionValue(ch),
      })),
    );
  } catch (error) {
    logger.warn("Failed to provide /tv autocomplete choices.", error);
  }
}

async function executeChannelChange(
  interaction: ChatInputCommandInteraction,
  ctx: TvCommandContext,
  logger: Logger,
): Promise<void> {
  const query = interaction.options.getString("name", true);
  const target = await findChannelForQuery(ctx.baseUrl, ctx.channels, query, logger);

  if (!target) {
    await interaction.reply({
      content: `チャンネル「${query}」が見つかりませんでした。Bot のチャンネル一覧が古い可能性があります。管理者に再起動を依頼してください。`,
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
        : `\n> 現在の状態では **${reportedChannelName}** が報告されています。Bot のチャンネル一覧が古い可能性があるため、管理者に再起動を依頼してください。`;
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
  logger: Logger,
): Promise<void> {
  if (ctx.channels.length === 0) {
    await interaction.reply({
      content: "チャンネル一覧がまだ読み込まれていません。管理者に Bot の再起動を依頼してください。",
      ephemeral: true,
    });
    return;
  }

  const query = interaction.options.getString("query")?.trim() ?? "";
  const requestedPage = interaction.options.getInteger("page") ?? 1;
  const { matches, programs } = await searchChannelsForList(ctx.baseUrl, ctx.channels, query, logger);

  if (matches.length === 0) {
    const content =
      query === ""
        ? "表示できるチャンネルがありません。管理者に Bot の再起動を依頼してください。"
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
  const pagePrograms = programs.size > 0 ? programs : await getProgramsForDisplay(ctx.baseUrl, pageItems, logger);
  const lines = pageItems.map((channel, index) => {
    const lineNumber = startIndex + index + 1;
    const baseLine = `${lineNumber}. ${buildChannelChoiceLabel(channel, duplicateBaseLabels)}`;
    const programName =
      getProgramName(pagePrograms.get(buildChannelProgramCacheKey(ctx.baseUrl, channel))) ??
      getProgramNameFromCache(ctx.baseUrl, channel);
    return programName ? `${baseLine} - ${truncateText(programName, LIST_PROGRAM_NAME_LIMIT)}` : baseLine;
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

export async function handleTvInteraction(
  interaction: Interaction,
  ctx: TvCommandContext,
  logger: Logger,
): Promise<void> {
  if (interaction.isAutocomplete() && interaction.commandName === TV_COMMAND_NAME) {
    await handleTvAutocomplete(interaction, ctx, logger);
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
      await executeList(interaction, ctx, logger);
    } else if (subcommand === SUBCOMMAND_STATUS) {
      await executeStatus(interaction, ctx, logger);
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

async function searchChannelsForAutocomplete(
  baseUrl: string,
  channels: readonly UnifiedChannel[],
  query: string,
  logger: Logger,
): Promise<SearchChannelsResult> {
  if (normalizeSearchText(query) === "") {
    const matches = searchChannels([...channels], query);
    const programs = await getProgramsForDisplay(baseUrl, matches, logger);
    return { matches, programs };
  }

  return searchChannelsWithPrograms(baseUrl, channels, query, logger, AUTOCOMPLETE_RESULT_LIMIT);
}

async function searchChannelsForList(
  baseUrl: string,
  channels: readonly UnifiedChannel[],
  query: string,
  logger: Logger,
): Promise<SearchChannelsResult> {
  if (normalizeSearchText(query) === "") {
    return { matches: searchChannelsByMetadata(channels, query), programs: new Map() };
  }

  return searchChannelsWithPrograms(baseUrl, channels, query, logger);
}

async function findChannelForQuery(
  baseUrl: string,
  channels: readonly UnifiedChannel[],
  query: string,
  logger: Logger,
): Promise<UnifiedChannel | undefined> {
  const directMatch = findChannel([...channels], query);
  if (directMatch) {
    return directMatch;
  }

  const { matches } = await searchChannelsWithPrograms(baseUrl, channels, query, logger, 1);
  return matches[0];
}

async function searchChannelsWithPrograms(
  baseUrl: string,
  channels: readonly UnifiedChannel[],
  query: string,
  logger: Logger,
  limit?: number,
): Promise<SearchChannelsResult> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery === "") {
    const matches = searchChannelsByMetadata(channels, query);
    return {
      matches: limit ? matches.slice(0, limit) : matches,
      programs: new Map(),
    };
  }

  const programs = await getProgramsForDisplay(baseUrl, channels, logger);
  const matches = rankChannelsWithPrograms(baseUrl, channels, programs, normalizedQuery).map((match) => match.channel);

  return {
    matches: limit ? matches.slice(0, limit) : matches,
    programs,
  };
}

async function getProgramsForDisplay(
  baseUrl: string,
  channels: readonly UnifiedChannel[],
  logger: Logger,
): Promise<Map<string, TvTestChannelProgramResult>> {
  const results = new Map<string, TvTestChannelProgramResult>();
  const now = Date.now();
  const uncachedChannels: UnifiedChannel[] = [];

  channels.forEach((channel) => {
    const key = buildChannelProgramCacheKey(baseUrl, channel);
    const cached = channelProgramCache.get(key);

    if (cached && cached.expiresAtMs > now) {
      results.set(key, cached.result);
      return;
    }

    channelProgramCache.delete(key);
    uncachedChannels.push(channel);
  });

  if (uncachedChannels.length === 0) {
    return results;
  }

  try {
    const fetched = await tvGetProgramsForChannels(
      baseUrl,
      uncachedChannels.map((channel) => buildProgramQuery(channel)),
    );

    fetched.forEach((result, index) => {
      const channel = uncachedChannels[index];
      if (!channel) {
        return;
      }

      const key = buildChannelProgramCacheKey(baseUrl, channel);
      channelProgramCache.set(key, {
        expiresAtMs: now + CHANNEL_PROGRAM_CACHE_TTL_MS,
        result,
      });
      results.set(key, result);
    });
  } catch (error) {
    logger.warn("Failed to fetch current TV programs for channel display.", error);
  }

  return results;
}

function buildChannelProgramCacheKey(baseUrl: string, channel: UnifiedChannel): string {
  return `${baseUrl.replace(/\/$/, "")}::${channel.driver}::${channel.space}::${channel.channel}`;
}

function getProgramNameFromCache(baseUrl: string, channel: UnifiedChannel): string | undefined {
  const key = buildChannelProgramCacheKey(baseUrl, channel);
  const cached = channelProgramCache.get(key);
  if (!cached || cached.expiresAtMs <= Date.now()) {
    return undefined;
  }

  return getProgramName(cached.result);
}

function buildProgramQuery(channel: UnifiedChannel): { networkId: number; serviceId: number } | { space: number; channel: number } {
  if (channel.networkId > 0 && channel.serviceId > 0) {
    return {
      networkId: channel.networkId,
      serviceId: channel.serviceId,
    };
  }

  return {
    space: channel.space,
    channel: channel.channel,
  };
}

function searchChannelsByMetadata(channels: readonly UnifiedChannel[], query: string): UnifiedChannel[] {
  return normalizeSearchText(query) === "" ? [...channels].sort(compareChannelsForDisplay) : rankChannelsByMetadata(channels, query);
}

function rankChannelsByMetadata(channels: readonly UnifiedChannel[], query: string): UnifiedChannel[] {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery === "") {
    return [...channels].sort(compareChannelsForDisplay);
  }

  return channels
    .map((channel, index) => {
      const displayName = normalizeSearchText(channel.displayName);
      const networkName = normalizeSearchText(channel.networkName);
      const driverName = normalizeSearchText(channel.driver);

      const score = Math.min(
        getMatchScore(displayName, normalizedQuery, 0),
        getMatchScore(networkName, normalizedQuery, 40),
        getMatchScore(driverName, normalizedQuery, 80),
      );

      if (!Number.isFinite(score)) {
        return undefined;
      }

      return { channel, score, index };
    })
    .filter((match): match is RankedChannelWithProgram => match !== undefined)
    .sort(compareRankedChannels)
    .map((match) => match.channel);
}

function rankChannelsWithPrograms(
  baseUrl: string,
  channels: readonly UnifiedChannel[],
  programs: ReadonlyMap<string, TvTestChannelProgramResult>,
  normalizedQuery: string,
): RankedChannelWithProgram[] {
  return channels
    .map((channel, index) => {
      const displayName = normalizeSearchText(channel.displayName);
      const networkName = normalizeSearchText(channel.networkName);
      const driverName = normalizeSearchText(channel.driver);
      const programName = normalizeSearchText(
        getProgramName(programs.get(buildChannelProgramCacheKey(baseUrl, channel))) ?? "",
      );

      const score = Math.min(
        getMatchScore(displayName, normalizedQuery, 0),
        getMatchScore(programName, normalizedQuery, 20),
        getMatchScore(networkName, normalizedQuery, 40),
        getMatchScore(driverName, normalizedQuery, 80),
      );

      if (!Number.isFinite(score)) {
        return undefined;
      }

      return { channel, score, index };
    })
    .filter((match): match is RankedChannelWithProgram => match !== undefined)
    .sort(compareRankedChannels);
}

function compareRankedChannels(left: RankedChannelWithProgram, right: RankedChannelWithProgram): number {
  if (left.score !== right.score) {
    return left.score - right.score;
  }

  return compareChannelsForDisplay(left.channel, right.channel) || left.index - right.index;
}

function compareChannelsForDisplay(left: UnifiedChannel, right: UnifiedChannel): number {
  const displayNameOrder = left.displayName.localeCompare(right.displayName, "ja");
  if (displayNameOrder !== 0) {
    return displayNameOrder;
  }

  const networkNameOrder = left.networkName.localeCompare(right.networkName, "ja");
  if (networkNameOrder !== 0) {
    return networkNameOrder;
  }

  const driverOrder = left.driver.localeCompare(right.driver, "ja");
  if (driverOrder !== 0) {
    return driverOrder;
  }

  if (left.space !== right.space) {
    return left.space - right.space;
  }

  return left.channel - right.channel;
}

function buildAutocompleteChoiceName(
  channel: UnifiedChannel,
  duplicateBaseLabels: ReadonlySet<string>,
  programResult?: TvTestChannelProgramResult,
): string {
  const baseLabel = buildChannelChoiceLabel(channel, duplicateBaseLabels);
  const programName = getProgramName(programResult);

  if (!programName) {
    return truncateText(baseLabel, AUTOCOMPLETE_CHOICE_NAME_LIMIT);
  }

  const separator = " - ";
  const availableProgramLength = AUTOCOMPLETE_CHOICE_NAME_LIMIT - baseLabel.length - separator.length;
  if (availableProgramLength <= 0) {
    return truncateText(baseLabel, AUTOCOMPLETE_CHOICE_NAME_LIMIT);
  }

  return `${baseLabel}${separator}${truncateText(programName, availableProgramLength)}`;
}

function getProgramName(programResult?: TvTestChannelProgramResult): string | undefined {
  if (programResult?.status !== "available") {
    return undefined;
  }

  const name = programResult.program?.name?.trim();
  return name ? name : undefined;
}

function getMatchScore(value: string, query: string, baseScore: number): number {
  if (value === "") {
    return Number.POSITIVE_INFINITY;
  }

  if (value === query) {
    return baseScore;
  }

  if (value.startsWith(query)) {
    return baseScore + 10;
  }

  const position = value.indexOf(query);
  if (position === -1) {
    return Number.POSITIVE_INFINITY;
  }

  return baseScore + 20 + position;
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  if (limit <= 3) {
    return value.slice(0, limit);
  }

  return `${value.slice(0, limit - 3)}...`;
}

function isSameChannelName(left: string, right: string): boolean {
  return normalizeChannelName(left) === normalizeChannelName(right);
}

function normalizeChannelName(value: string): string {
  return normalizeSearchText(value);
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000\-‐‑‒–—―ーｰ_./・()（）[\]［］]+/g, "");
}
