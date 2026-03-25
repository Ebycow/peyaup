export interface TvTestChannelEntry {
  space: number;
  /** /api/channel に渡すチャンネル一覧インデックス */
  channel: number;
  remoteControlKey: number;
  serviceId: number;
  networkId: number;
  transportStreamId?: number;
  name: string;
  networkName: string;
}

export interface TvTestChannelInfo {
  space: number;
  /** 現在視聴中チャンネルとして TVTest が報告する値。channel list の index とは限らない */
  channel: number;
  remoteControlKey: number;
  serviceId: number;
  networkId: number;
  name: string;
  networkName: string;
}

export interface TvTestProgramInfo {
  name: string;
  text: string;
}

export interface TvTestStatus {
  channel: TvTestChannelInfo | null;
  volume: number;
  mute: boolean;
  recording: number;
  program: TvTestProgramInfo | null;
}

export interface TvTestDriverInfo {
  current: string;
  drivers: string[];
}

function buildUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

async function getJson<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(buildUrl(baseUrl, path));
  if (!response.ok) {
    throw new Error(`TVTest API GET ${path} failed: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

async function postJson<T>(baseUrl: string, path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(buildUrl(baseUrl, path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`TVTest API POST ${path} failed: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export async function tvGetStatus(baseUrl: string): Promise<TvTestStatus> {
  return getJson<TvTestStatus>(baseUrl, "/api/status");
}

export async function tvGetChannels(baseUrl: string): Promise<TvTestChannelEntry[]> {
  return getJson<TvTestChannelEntry[]>(baseUrl, "/api/channels");
}

export async function tvGetDriver(baseUrl: string): Promise<TvTestDriverInfo> {
  return getJson<TvTestDriverInfo>(baseUrl, "/api/driver");
}

export async function tvChangeChannel(baseUrl: string, space: number, channel: number): Promise<void> {
  await postJson(baseUrl, "/api/channel", { space, channel });
}

export async function tvChangeDriver(
  baseUrl: string,
  driver: string,
  space: number,
  channel: number,
): Promise<void> {
  await postJson(baseUrl, "/api/driver", { driver, space, channel });
}
