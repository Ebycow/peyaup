import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
} from "../src/tv-channels.js";
import type { Logger } from "../src/logger.js";

const ZERO_TUNING_DELAYS: TvTuningDelays = {
  postDriverSwitchDelayMs: 0,
  postChannelChangeDelayMs: 0,
};

function createChannel(overrides: Partial<UnifiedChannel> = {}): UnifiedChannel {
  return {
    displayName: "NHK総合",
    driver: "BonDriver_Proxy_T.dll",
    space: 0,
    channel: 1,
    serviceId: 101,
    networkId: 201,
    networkName: "地上デジタル",
    ...overrides,
  };
}

function createLoggerStub(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("searchChannels", () => {
  it("finds symbol-separated channel names with normalized input", () => {
    const channels = [
      createChannel({ displayName: "BSJapanext" }),
      createChannel({ displayName: "J-SPORTS 1", channel: 2 }),
      createChannel({ displayName: "ショップチャンネル", channel: 3 }),
    ];

    const matches = searchChannels(channels, "jsports");

    expect(matches[0]?.displayName).toBe("J-SPORTS 1");
  });

  it("keeps autocomplete results capped at 25 items", () => {
    const channels = Array.from({ length: 40 }, (_, index) =>
      createChannel({
        displayName: `J-SPORTS ${index + 1}`,
        channel: index + 1,
      }),
    );

    const matches = searchChannels(channels, "j-sports");

    expect(matches).toHaveLength(25);
  });
});

describe("searchAllChannels", () => {
  it("returns all matching channels for list views without truncating to 25", () => {
    const channels = Array.from({ length: 40 }, (_, index) =>
      createChannel({
        displayName: `J-SPORTS ${index + 1}`,
        channel: index + 1,
      }),
    );

    const matches = searchAllChannels(channels, "j-sports");

    expect(matches).toHaveLength(40);
    expect(matches[0]?.displayName).toBe("J-SPORTS 1");
  });
});

describe("summarizeChannelsByNetwork", () => {
  it("groups channels by network name and fills blanks as uncategorized", () => {
    const summary = summarizeChannelsByNetwork([
      createChannel({ networkName: "BS" }),
      createChannel({ networkName: "BS", channel: 2 }),
      createChannel({ networkName: "", channel: 3 }),
    ]);

    expect(summary).toEqual([
      { networkName: "BS", count: 2 },
      { networkName: "未分類", count: 1 },
    ]);
  });
});

describe("findChannel", () => {
  it("resolves an autocomplete selection value to the exact channel", () => {
    const first = createChannel({
      driver: "BonDriver_Proxy_T.dll",
      space: 0,
      channel: 1,
    });
    const second = createChannel({
      driver: "BonDriver_Proxy_S.dll",
      space: 1,
      channel: 12,
      networkName: "BS",
    });

    const selected = findChannel([first, second], encodeChannelSelectionValue(second));

    expect(selected).toEqual(second);
  });

  it("falls back to normalized text matching for direct manual input", () => {
    const target = createChannel({ displayName: "J-SPORTS 3", channel: 10 });
    const selected = findChannel([target], "j sports");

    expect(selected).toEqual(target);
  });
});

describe("buildChannelChoiceLabel", () => {
  it("omits empty parentheses when network name is blank", () => {
    const label = buildChannelChoiceLabel(createChannel({ networkName: "" }));

    expect(label).toBe("NHK総合");
  });

  it("adds driver and indices when the base label is duplicated", () => {
    const channel = createChannel({
      displayName: "J-SPORTS 1",
      driver: "BonDriver_Proxy_S.dll",
      space: 3,
      channel: 21,
      networkName: "BS",
    });

    const label = buildChannelChoiceLabel(channel, new Set(["J-SPORTS 1 (BS)"]));

    expect(label).toBe("J-SPORTS 1 (BS) [BonDriver_Proxy_S.dll / s3 / ch21]");
  });
});

describe("tuneToChannel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("switches the driver first when the target channel belongs to another BonDriver", async () => {
    const target = createChannel({
      displayName: "J-SPORTS 2",
      driver: "BonDriver_Proxy_S.dll",
      space: 3,
      channel: 22,
      serviceId: 301,
      networkId: 401,
      networkName: "BS",
    });

    let currentDriver = "BonDriver_Proxy_T.dll";
    let currentStatusChannel = {
      space: 0,
      channel: 1,
      remoteControlKey: 1,
      serviceId: 101,
      networkId: 201,
      name: "ＮＨＫ総合１・長野",
      networkName: "地上デジタル",
    };
    const requestOrder: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const method = init?.method ?? "GET";

        if (url.endsWith("/api/driver") && method === "GET") {
          return new Response(JSON.stringify({ current: currentDriver, drivers: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.endsWith("/api/driver") && method === "POST") {
          requestOrder.push("driver");
          currentDriver = target.driver;

          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.endsWith("/api/channel") && method === "POST") {
          requestOrder.push("channel");
          currentStatusChannel = {
            space: target.space,
            channel: target.channel,
            remoteControlKey: 12,
            serviceId: target.serviceId,
            networkId: target.networkId,
            name: target.displayName,
            networkName: target.networkName,
          };

          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.endsWith("/api/status") && method === "GET") {
          return new Response(
            JSON.stringify({
              channel: currentStatusChannel,
              volume: 50,
              mute: false,
              recording: 0,
              program: {
                name: "新しい番組",
                text: "",
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }),
    );

    const promise = tuneToChannel("http://tvtest.local", target, ZERO_TUNING_DELAYS);
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(requestOrder).toEqual(["driver", "channel"]);
    expect(result.driverSwitched).toBe(true);
    expect(result.statusConfirmed).toBe(true);
    expect(result.status.channel?.name).toBe("J-SPORTS 2");
  });

  it("waits before selecting a channel after switching BonDriver", async () => {
    const target = createChannel({
      displayName: "J-SPORTS 2",
      driver: "BonDriver_Proxy_S.dll",
      space: 3,
      channel: 22,
      serviceId: 301,
      networkId: 401,
      networkName: "BS",
    });

    let currentDriver = "BonDriver_Proxy_T.dll";
    let currentStatusChannel = {
      space: 0,
      channel: 1,
      remoteControlKey: 1,
      serviceId: 101,
      networkId: 201,
      name: "ＮＨＫ総合１・長野",
      networkName: "地上デジタル",
    };
    const requestOrder: string[] = [];
    const delayedTimings: TvTuningDelays = {
      postDriverSwitchDelayMs: 1200,
      postChannelChangeDelayMs: 500,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const method = init?.method ?? "GET";

        if (url.endsWith("/api/driver") && method === "GET") {
          return new Response(JSON.stringify({ current: currentDriver, drivers: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.endsWith("/api/driver") && method === "POST") {
          requestOrder.push("driver");
          currentDriver = target.driver;

          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.endsWith("/api/channel") && method === "POST") {
          requestOrder.push("channel");
          currentStatusChannel = {
            space: target.space,
            channel: target.channel,
            remoteControlKey: 12,
            serviceId: target.serviceId,
            networkId: target.networkId,
            name: target.displayName,
            networkName: target.networkName,
          };

          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.endsWith("/api/status") && method === "GET") {
          return new Response(
            JSON.stringify({
              channel: currentStatusChannel,
              volume: 50,
              mute: false,
              recording: 0,
              program: {
                name: "新しい番組",
                text: "",
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }),
    );

    const promise = tuneToChannel("http://tvtest.local", target, delayedTimings);
    await vi.advanceTimersByTimeAsync(1000);
    expect(requestOrder).toEqual(["driver"]);

    await vi.advanceTimersByTimeAsync(700);
    expect(requestOrder).toEqual(["driver", "channel"]);

    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result.statusConfirmed).toBe(true);
  });

  it("waits until the status reflects the tuned channel", async () => {
    const target = createChannel({
      displayName: "J-SPORTS 2",
      driver: "BonDriver_Proxy_S.dll",
      space: 3,
      channel: 22,
      serviceId: 301,
      networkId: 401,
      networkName: "BS",
    });

    let statusCallCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const method = init?.method ?? "GET";

        if (url.endsWith("/api/driver") && method === "GET") {
          return new Response(JSON.stringify({ current: "BonDriver_Proxy_S.dll", drivers: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.endsWith("/api/channel") && method === "POST") {
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.endsWith("/api/status") && method === "GET") {
          statusCallCount += 1;
          const payload =
            statusCallCount < 2
              ? {
                  channel: {
                    space: 1,
                    channel: 12,
                    remoteControlKey: 9,
                    serviceId: 100,
                    networkId: 200,
                    name: "WOWOWプライム",
                    networkName: "BS",
                  },
                  volume: 50,
                  mute: false,
                  recording: 0,
                  program: {
                    name: "古い番組",
                    text: "",
                  },
                }
              : {
                  channel: {
                    space: 3,
                    channel: 22,
                    remoteControlKey: 12,
                    serviceId: 301,
                    networkId: 401,
                    name: "J-SPORTS 2",
                    networkName: "BS",
                  },
                  volume: 50,
                  mute: false,
                  recording: 0,
                  program: {
                    name: "新しい番組",
                    text: "",
                  },
                };

          return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }),
    );

    const promise = tuneToChannel("http://tvtest.local", target, ZERO_TUNING_DELAYS);
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result.statusConfirmed).toBe(true);
    expect(result.status.channel?.name).toBe("J-SPORTS 2");
    expect(result.status.program?.name).toBe("新しい番組");
    expect(statusCallCount).toBeGreaterThanOrEqual(2);
  });

  it("does not confirm a channel when the reported service differs", async () => {
    const target = createChannel({
      displayName: "LaLaTV",
      driver: "BonDriver_Proxy_S.dll",
      space: 3,
      channel: 22,
      serviceId: 301,
      networkId: 401,
      networkName: "CS",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const method = init?.method ?? "GET";

        if (url.endsWith("/api/driver") && method === "GET") {
          return new Response(JSON.stringify({ current: "BonDriver_Proxy_S.dll", drivers: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.endsWith("/api/channel") && method === "POST") {
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.endsWith("/api/status") && method === "GET") {
          return new Response(
            JSON.stringify({
              channel: {
                space: 3,
                channel: 22,
                remoteControlKey: 12,
                serviceId: 999,
                networkId: 998,
                name: "GAORA",
                networkName: "CS",
              },
              volume: 50,
              mute: false,
              recording: 0,
              program: {
                name: "別番組",
                text: "",
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }),
    );

    const promise = tuneToChannel("http://tvtest.local", target, ZERO_TUNING_DELAYS);
    await vi.advanceTimersByTimeAsync(4500);
    const result = await promise;

    expect(result.statusConfirmed).toBe(false);
    expect(result.status.channel?.name).toBe("GAORA");
  });
});

describe("getCurrentChannel", () => {
  it("ignores a cached channel entry when service identity does not match", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

        if (url.endsWith("/api/driver")) {
          return new Response(JSON.stringify({ current: "BonDriver_Proxy_S.dll", drivers: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.endsWith("/api/status")) {
          return new Response(
            JSON.stringify({
              channel: {
                space: 3,
                channel: 22,
                remoteControlKey: 12,
                serviceId: 999,
                networkId: 998,
                name: "GAORA",
                networkName: "CS",
              },
              volume: 50,
              mute: false,
              recording: 0,
              program: null,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const current = await getCurrentChannel("http://tvtest.local", [
      createChannel({
        displayName: "LaLaTV",
        driver: "BonDriver_Proxy_S.dll",
        space: 3,
        channel: 22,
        serviceId: 301,
        networkId: 401,
        networkName: "CS",
      }),
    ]);

    expect(current).toBeUndefined();
  });
});

describe("discoverAllChannels", () => {
  it("waits for the driver switch and a stable channel list before caching entries", async () => {
    vi.useFakeTimers();

    const logger = createLoggerStub();
    let currentDriver = "BonDriver_Proxy_T.dll";
    let pendingDriver: string | null = null;
    let channelPollCount = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const method = init?.method ?? "GET";

        if (url.endsWith("/api/driver") && method === "GET") {
          if (pendingDriver !== null) {
            currentDriver = pendingDriver;
            pendingDriver = null;
          }

          return new Response(JSON.stringify({ current: currentDriver, drivers: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.endsWith("/api/driver") && method === "POST") {
          const body = typeof init?.body === "string" ? init.body : "";
          const nextDriver = JSON.parse(body).driver as string;
          pendingDriver = nextDriver;

          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.endsWith("/api/channels")) {
          channelPollCount += 1;
          const channels =
            channelPollCount < 2
              ? [
                  {
                    space: 1,
                    channel: 10,
                    remoteControlKey: 1,
                    serviceId: 111,
                    networkId: 211,
                    name: "古いチャンネル一覧",
                    networkName: "旧",
                  },
                ]
              : [
                  {
                    space: 3,
                    channel: 22,
                    remoteControlKey: 12,
                    serviceId: 301,
                    networkId: 401,
                    name: "LaLaTV",
                    networkName: "CS",
                  },
                ];

          return new Response(JSON.stringify(channels), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.endsWith("/api/status") && method === "GET") {
          return new Response(
            JSON.stringify({
              channel: null,
              volume: 50,
              mute: false,
              recording: 0,
              program: null,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }),
    );

    const promise = discoverAllChannels(
      "http://tvtest.local",
      ["BonDriver_Proxy_S.dll"],
      logger,
      ZERO_TUNING_DELAYS,
    );
    await vi.advanceTimersByTimeAsync(1000);
    const channels = await promise;

    expect(channels).toHaveLength(1);
    expect(channels[0]?.displayName).toBe("LaLaTV");
    expect(channels[0]?.serviceId).toBe(301);
  });

  it("retunes the original channel after restoring the original driver", async () => {
    vi.useFakeTimers();

    const logger = createLoggerStub();
    const originalStatusChannel = {
      space: 0,
      channel: 27,
      remoteControlKey: 1,
      serviceId: 101,
      networkId: 201,
      name: "ＮＨＫ総合１・長野",
      networkName: "地上デジタル",
    };
    const originalChannelEntry = {
      space: 0,
      channel: 1,
      remoteControlKey: 1,
      serviceId: 101,
      networkId: 201,
      name: "ＮＨＫ総合１・長野",
      networkName: "地上デジタル",
    };
    const discoveredChannel = {
      space: 3,
      channel: 22,
      remoteControlKey: 12,
      serviceId: 301,
      networkId: 401,
      name: "LaLaTV",
      networkName: "CS",
    };

    let currentDriver = "BonDriver_Proxy_T.dll";
    let pendingDriver: string | null = null;
    let currentStatusChannel: typeof originalStatusChannel | typeof discoveredChannel | null = originalStatusChannel;
    let discoveredDriverPollCount = 0;
    const requestOrder: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const method = init?.method ?? "GET";

        if (url.endsWith("/api/driver") && method === "GET") {
          if (pendingDriver !== null) {
            currentDriver = pendingDriver;
            pendingDriver = null;
            currentStatusChannel = currentDriver === "BonDriver_Proxy_S.dll" ? discoveredChannel : null;
          }

          return new Response(JSON.stringify({ current: currentDriver, drivers: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.endsWith("/api/driver") && method === "POST") {
          const body = typeof init?.body === "string" ? init.body : "";
          const nextDriver = JSON.parse(body).driver as string;
          pendingDriver = nextDriver;
          requestOrder.push(`driver:${nextDriver}`);

          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.endsWith("/api/channel") && method === "POST") {
          const body = typeof init?.body === "string" ? init.body : "";
          const parsed = JSON.parse(body) as { space: number; channel: number };
          requestOrder.push(`channel:${parsed.space}:${parsed.channel}`);

          if (
            currentDriver === "BonDriver_Proxy_T.dll" &&
            parsed.space === originalChannelEntry.space &&
            parsed.channel === originalChannelEntry.channel
          ) {
            currentStatusChannel = originalStatusChannel;
          }

          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.endsWith("/api/channels") && method === "GET") {
          const channels =
            currentDriver === "BonDriver_Proxy_S.dll"
              ? (discoveredDriverPollCount += 1) < 2
                ? [
                    {
                      space: 1,
                      channel: 10,
                      remoteControlKey: 1,
                      serviceId: 111,
                      networkId: 211,
                      name: "古いチャンネル一覧",
                      networkName: "旧",
                    },
                  ]
                : [discoveredChannel]
              : [originalChannelEntry];

          return new Response(JSON.stringify(channels), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.endsWith("/api/status") && method === "GET") {
          return new Response(
            JSON.stringify({
              channel: currentStatusChannel,
              volume: 50,
              mute: false,
              recording: 0,
              program: currentStatusChannel
                ? {
                    name: "番組",
                    text: "",
                  }
                : null,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }),
    );

    const promise = discoverAllChannels(
      "http://tvtest.local",
      ["BonDriver_Proxy_S.dll"],
      logger,
      ZERO_TUNING_DELAYS,
    );
    await vi.advanceTimersByTimeAsync(1500);
    const channels = await promise;

    expect(channels).toHaveLength(1);
    expect(requestOrder).toEqual([
      "driver:BonDriver_Proxy_S.dll",
      "driver:BonDriver_Proxy_T.dll",
      "channel:0:1",
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      "Restored driver: BonDriver_Proxy_T.dll, channel: ＮＨＫ総合１・長野",
    );
  });
});
