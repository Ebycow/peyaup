import type { Logger } from "./logger.js";
import {
  tvChangeChannel,
  tvGetChannels,
  tvGetDriver,
  tvGetStatus,
  type TvTestChannelEntry,
  type TvTestChannelInfo,
  type TvTestStatus,
} from "./tvtest.js";

export interface UnifiedChannel {
  /** ユーザー向け表示名 (例: "NHK総合", "NHK BS1") */
  displayName: string;
  /** 対応する BonDriver ファイル名 */
  driver: string;
  /** チューニング空間インデックス */
  space: number;
  /** チャンネルインデックス */
  channel: number;
  /** サービスID */
  serviceId: number;
  /** ネットワークID */
  networkId: number;
  /** ネットワーク名 (例: "地上デジタル", "BS") */
  networkName: string;
}

export interface TuneResult {
  channel: UnifiedChannel;
  status: TvTestStatus;
  driverSwitched: boolean;
  statusConfirmed: boolean;
}

export interface TvTuningDelays {
  postDriverSwitchDelayMs: number;
  postChannelChangeDelayMs: number;
}

export const DEFAULT_TV_TUNING_DELAYS: Readonly<TvTuningDelays> = {
  postDriverSwitchDelayMs: 1200,
  postChannelChangeDelayMs: 500,
};

const AUTOCOMPLETE_RESULT_LIMIT = 25;
const CHANNEL_SELECTION_SEPARATOR = "::";
const CHANNEL_SETTLE_TIMEOUT_MS = 4000;
const CHANNEL_SETTLE_POLL_INTERVAL_MS = 150;
const DRIVER_SWITCH_TIMEOUT_MS = 4000;
const CHANNEL_LIST_SETTLE_TIMEOUT_MS = 4000;
const UNCATEGORIZED_NETWORK_NAME = "未分類";

/**
 * 指定した BonDriver を順番に切り替えてチャンネルを列挙し、元の Driver に戻す。
 * drivers が空の場合は現在のドライバのみを対象にする。
 * 起動時のチャンネル探索で呼び出す。
 */
export async function discoverAllChannels(
  baseUrl: string,
  drivers: string[],
  logger: Logger,
  tuningDelays: TvTuningDelays = DEFAULT_TV_TUNING_DELAYS,
): Promise<UnifiedChannel[]> {
  const [driverInfo, statusBeforeDiscovery] = await Promise.all([
    tvGetDriver(baseUrl),
    tvGetStatus(baseUrl),
  ]);
  const originalDriver = driverInfo.current;
  const originalChannel = statusBeforeDiscovery.channel;

  const targets = drivers.length > 0 ? drivers : [originalDriver];
  const switchedAwayFromOriginalDriver = targets.some((driver) => driver !== originalDriver);
  logger.info(`Discovering channels across ${targets.length} drivers: ${targets.join(", ")}`);

  const allChannels: UnifiedChannel[] = [];

  for (const driver of targets) {
    try {
      // ドライバを切り替えてチャンネル一覧を取得（チャンネル指定なし）
      await switchDriver(baseUrl, driver, tuningDelays);
      const entries = await waitForChannelListToSettle(baseUrl, driver);

      for (const entry of entries) {
        allChannels.push(createUnifiedChannelFromEntry(driver, entry));
      }

      logger.info(`Driver ${driver}: ${entries.length} channels found.`);
    } catch (error) {
      logger.warn(`Driver ${driver}: channel discovery failed.`, error);
    }
  }

  // 元のドライバ・チャンネルに戻す
  if (originalDriver !== "") {
    try {
      await switchDriver(baseUrl, originalDriver, tuningDelays);

      if (originalChannel !== null && switchedAwayFromOriginalDriver) {
        const originalDriverEntries = await waitForChannelListToSettle(baseUrl, originalDriver);
        const originalTarget = findChannelFromStatus(originalDriver, originalChannel, originalDriverEntries);

        if (!originalTarget) {
          logger.warn(
            `Original channel could not be resolved in driver ${originalDriver}; channel restore skipped. Status channel: ${originalChannel.name}.`,
          );
          return deduplicateChannels(allChannels);
        }

        const restored = await tuneToChannel(baseUrl, originalTarget, tuningDelays);
        const restoredChannelName = restored.status.channel?.name?.trim() ?? "";

        if (restored.statusConfirmed) {
          logger.info(`Restored driver: ${originalDriver}, channel: ${restoredChannelName || originalTarget.displayName}`);
        } else {
          logger.warn(
            `Driver ${originalDriver} was restored, but channel tuning could not be confirmed. Last reported channel: ${restoredChannelName || "none"}.`,
          );
        }
      } else if (switchedAwayFromOriginalDriver) {
        logger.info(`Restored driver: ${originalDriver}`);
      }
    } catch (error) {
      logger.warn(`Failed to restore original driver ${originalDriver}.`, error);
    }
  }

  return deduplicateChannels(allChannels);
}

/** 同一 (driver, space, channel) の重複を除去する */
function deduplicateChannels(channels: UnifiedChannel[]): UnifiedChannel[] {
  const seen = new Set<string>();
  return channels.filter((ch) => {
    const key = `${ch.driver}:${ch.space}:${ch.channel}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function createUnifiedChannelFromEntry(driver: string, entry: TvTestChannelEntry): UnifiedChannel {
  return {
    displayName: entry.name,
    driver,
    space: entry.space,
    channel: entry.channel,
    serviceId: entry.serviceId,
    networkId: entry.networkId,
    networkName: entry.networkName,
  };
}

/** ドライバ名だけで切り替える (チャンネルは指定しない) */
async function switchDriver(
  baseUrl: string,
  driver: string,
  tuningDelays: TvTuningDelays,
  currentDriver?: string,
): Promise<void> {
  const activeDriver = currentDriver ?? (await tvGetDriver(baseUrl)).current;
  if (activeDriver === driver) {
    return;
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/driver`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ driver }),
  });
  if (!response.ok) {
    throw new Error(`Driver switch to ${driver} failed: ${response.status}`);
  }

  await waitForDriver(baseUrl, driver);

  if (tuningDelays.postDriverSwitchDelayMs > 0) {
    await delay(tuningDelays.postDriverSwitchDelayMs);
  }
}

/**
 * 入力文字列でチャンネルを検索する。
 * 完全一致 → 前方一致 → 部分一致 の順で最初にヒットしたものを返す。
 */
export function findChannel(channels: UnifiedChannel[], query: string): UnifiedChannel | undefined {
  return findChannelBySelectionValue(channels, query) ?? searchAllChannels(channels, query)[0];
}

/**
 * Autocomplete 用: 入力文字列にマッチするチャンネルを最大 25 件返す。
 */
export function searchChannels(channels: UnifiedChannel[], query: string): UnifiedChannel[] {
  return searchAllChannels(channels, query).slice(0, AUTOCOMPLETE_RESULT_LIMIT);
}

export function searchAllChannels(channels: UnifiedChannel[], query: string): UnifiedChannel[] {
  if (normalizeSearchText(query) === "") {
    return channels.slice().sort(compareChannelsForDisplay);
  }

  return rankChannels(channels, query).map((match) => match.channel);
}

export interface ChannelNetworkSummary {
  networkName: string;
  count: number;
}

export function summarizeChannelsByNetwork(channels: UnifiedChannel[]): ChannelNetworkSummary[] {
  const counts = new Map<string, number>();

  channels.forEach((channel) => {
    const networkName = channel.networkName.trim() || UNCATEGORIZED_NETWORK_NAME;
    counts.set(networkName, (counts.get(networkName) ?? 0) + 1);
  });

  return Array.from(counts.entries())
    .map(([networkName, count]) => ({ networkName, count }))
    .sort((left, right) => {
      if (left.count !== right.count) {
        return right.count - left.count;
      }

      return left.networkName.localeCompare(right.networkName, "ja");
    });
}

export function encodeChannelSelectionValue(channel: UnifiedChannel): string {
  return [
    encodeURIComponent(channel.driver),
    String(channel.space),
    String(channel.channel),
  ].join(CHANNEL_SELECTION_SEPARATOR);
}

export function buildChannelChoiceLabel(
  channel: UnifiedChannel,
  duplicateBaseLabels: ReadonlySet<string> = new Set(),
): string {
  const networkName = channel.networkName.trim();
  const baseLabel = networkName === "" ? channel.displayName : `${channel.displayName} (${networkName})`;

  if (!duplicateBaseLabels.has(baseLabel)) {
    return baseLabel;
  }

  return `${baseLabel} [${channel.driver} / s${channel.space} / ch${channel.channel}]`;
}

/**
 * チャンネルを透過的に切り替える。
 * 現在の BonDriver が対象と異なる場合は先に Driver を切り替えてからチャンネルを変更する。
 */
export async function tuneToChannel(
  baseUrl: string,
  target: UnifiedChannel,
  tuningDelays: TvTuningDelays = DEFAULT_TV_TUNING_DELAYS,
): Promise<TuneResult> {
  const driverInfo = await tvGetDriver(baseUrl);
  const currentDriver = driverInfo.current;

  let driverSwitched = false;

  if (currentDriver !== target.driver) {
    // BonDriver が異なる → 先に Driver を安定させてからチャンネルを合わせる
    await switchDriver(baseUrl, target.driver, tuningDelays, currentDriver);
    driverSwitched = true;
  }

  await tvChangeChannel(baseUrl, target.space, target.channel);

  if (tuningDelays.postChannelChangeDelayMs > 0) {
    await delay(tuningDelays.postChannelChangeDelayMs);
  }

  const { status, confirmed } = await waitForTunedStatus(baseUrl, target);
  return { channel: target, status, driverSwitched, statusConfirmed: confirmed };
}

/** 現在視聴中のチャンネルを UnifiedChannel リストから探して返す */
export async function getCurrentChannel(
  baseUrl: string,
  channels: UnifiedChannel[],
): Promise<UnifiedChannel | undefined> {
  const driverInfo = await tvGetDriver(baseUrl);
  const status = await tvGetStatus(baseUrl);
  if (!status.channel) return undefined;
  return channels.find(
    (ch) =>
      isMatchingChannel(driverInfo.current, status.channel!, ch),
  );
}

interface RankedChannel {
  channel: UnifiedChannel;
  score: number;
  index: number;
}

function findChannelBySelectionValue(
  channels: UnifiedChannel[],
  value: string,
): UnifiedChannel | undefined {
  const parts = value.split(CHANNEL_SELECTION_SEPARATOR);
  if (parts.length !== 3) {
    return undefined;
  }

  const [encodedDriver, spaceText, channelText] = parts;

  let driver: string;
  try {
    driver = decodeURIComponent(encodedDriver ?? "");
  } catch {
    return undefined;
  }

  const space = Number(spaceText);
  const channel = Number(channelText);
  if (!Number.isInteger(space) || !Number.isInteger(channel)) {
    return undefined;
  }

  return channels.find(
    (candidate) =>
      candidate.driver === driver &&
      candidate.space === space &&
      candidate.channel === channel,
  );
}

function rankChannels(channels: UnifiedChannel[], query: string): RankedChannel[] {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery === "") {
    return [];
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
    .filter((match): match is RankedChannel => match !== undefined)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }

      const displayNameOrder = left.channel.displayName.localeCompare(right.channel.displayName, "ja");
      if (displayNameOrder !== 0) {
        return displayNameOrder;
      }

      const networkNameOrder = left.channel.networkName.localeCompare(right.channel.networkName, "ja");
      if (networkNameOrder !== 0) {
        return networkNameOrder;
      }

      const driverOrder = left.channel.driver.localeCompare(right.channel.driver, "ja");
      if (driverOrder !== 0) {
        return driverOrder;
      }

      return left.index - right.index;
    });
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

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000\-‐‑‒–—―ーｰ_./・()（）[\]［］]+/g, "");
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

async function waitForTunedStatus(
  baseUrl: string,
  target: UnifiedChannel,
): Promise<{ status: TvTestStatus; confirmed: boolean }> {
  const deadline = Date.now() + CHANNEL_SETTLE_TIMEOUT_MS;
  let lastStatus: TvTestStatus | undefined;

  while (true) {
    const [driverInfo, status] = await Promise.all([tvGetDriver(baseUrl), tvGetStatus(baseUrl)]);
    lastStatus = status;

    if (isTargetTunedStatus(driverInfo.current, status, target)) {
      await delay(CHANNEL_SETTLE_POLL_INTERVAL_MS);
      const [settledDriverInfo, settledStatus] = await Promise.all([
        tvGetDriver(baseUrl),
        tvGetStatus(baseUrl),
      ]);

      if (isTargetTunedStatus(settledDriverInfo.current, settledStatus, target)) {
        return { status: settledStatus, confirmed: true };
      }

      lastStatus = settledStatus;
    }

    if (Date.now() >= deadline) {
      return { status: lastStatus, confirmed: false };
    }

    await delay(CHANNEL_SETTLE_POLL_INTERVAL_MS);
  }
}

function isTargetTunedStatus(
  currentDriver: string,
  status: TvTestStatus,
  target: UnifiedChannel,
): boolean {
  return status.channel !== null && isMatchingChannel(currentDriver, status.channel, target);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForDriver(baseUrl: string, expectedDriver: string): Promise<void> {
  const deadline = Date.now() + DRIVER_SWITCH_TIMEOUT_MS;

  while (true) {
    const driverInfo = await tvGetDriver(baseUrl);
    if (driverInfo.current === expectedDriver) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Driver did not settle to ${expectedDriver} within ${DRIVER_SWITCH_TIMEOUT_MS}ms`);
    }

    await delay(CHANNEL_SETTLE_POLL_INTERVAL_MS);
  }
}

async function waitForChannelListToSettle(
  baseUrl: string,
  expectedDriver: string,
): Promise<TvTestChannelEntry[]> {
  await waitForDriver(baseUrl, expectedDriver);

  const deadline = Date.now() + CHANNEL_LIST_SETTLE_TIMEOUT_MS;
  let previousSignature: string | undefined;
  let lastEntries: TvTestChannelEntry[] = [];

  await delay(CHANNEL_SETTLE_POLL_INTERVAL_MS);

  while (true) {
    const entries = await tvGetChannels(baseUrl);
    const signature = buildChannelListSignature(entries);

    if (signature === previousSignature) {
      return entries;
    }

    previousSignature = signature;
    lastEntries = entries;

    if (Date.now() >= deadline) {
      return lastEntries;
    }

    await delay(CHANNEL_SETTLE_POLL_INTERVAL_MS);
  }
}

function buildChannelListSignature(entries: readonly TvTestChannelEntry[]): string {
  return entries
    .map((entry) =>
      [
        entry.space,
        entry.channel,
        entry.serviceId,
        entry.networkId,
        entry.remoteControlKey,
        entry.name,
        entry.networkName,
      ].join(":"),
    )
    .join("|");
}

function findChannelFromStatus(
  driver: string,
  statusChannel: TvTestChannelInfo,
  entries: readonly TvTestChannelEntry[],
): UnifiedChannel | undefined {
  const normalizedStatusName = normalizeSearchText(statusChannel.name);
  const normalizedStatusNetworkName = normalizeSearchText(statusChannel.networkName);

  const matchedEntry =
    entries.find(
      (entry) =>
        entry.serviceId > 0 &&
        entry.networkId > 0 &&
        entry.serviceId === statusChannel.serviceId &&
        entry.networkId === statusChannel.networkId,
    ) ??
    entries.find(
      (entry) =>
        entry.remoteControlKey === statusChannel.remoteControlKey &&
        normalizeSearchText(entry.name) === normalizedStatusName,
    ) ??
    entries.find((entry) => entry.remoteControlKey === statusChannel.remoteControlKey) ??
    entries.find(
      (entry) =>
        normalizeSearchText(entry.name) === normalizedStatusName &&
        normalizeSearchText(entry.networkName) === normalizedStatusNetworkName,
    );

  return matchedEntry ? createUnifiedChannelFromEntry(driver, matchedEntry) : undefined;
}

function isMatchingChannel(
  currentDriver: string,
  statusChannel: TvTestChannelInfo,
  candidate: UnifiedChannel,
): boolean {
  if (candidate.driver !== currentDriver) {
    return false;
  }

  const hasServiceIdentity =
    candidate.serviceId > 0 &&
    candidate.networkId > 0 &&
    statusChannel.serviceId > 0 &&
    statusChannel.networkId > 0;

  if (hasServiceIdentity) {
    return (
      candidate.serviceId === statusChannel.serviceId &&
      candidate.networkId === statusChannel.networkId
    );
  }

  return candidate.space === statusChannel.space && candidate.channel === statusChannel.channel;
}
