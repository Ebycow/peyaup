import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../src/logger.js";
import { StreamMonitor, type VoiceStateSnapshot } from "../src/monitor.js";

const GUILD_ID = "guild-1";
const WATCH_USER_ID = "user-1";
const DEBOUNCE_MS = 1000;

function createState(overrides: Partial<VoiceStateSnapshot> = {}): VoiceStateSnapshot {
  return {
    guildId: GUILD_ID,
    userId: WATCH_USER_ID,
    channelId: "vc-1",
    streaming: true,
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

function setup(initialState: VoiceStateSnapshot) {
  let currentState = initialState;
  const notifyIncident = vi.fn(async () => {});

  const monitor = new StreamMonitor({
    guildId: GUILD_ID,
    watchUserId: WATCH_USER_ID,
    debounceMs: DEBOUNCE_MS,
    fetchCurrentState: async () => currentState,
    notifyIncident,
    logger: createLoggerStub(),
  });

  return {
    monitor,
    notifyIncident,
    setCurrentState(nextState: VoiceStateSnapshot) {
      currentState = nextState;
    },
  };
}

describe("StreamMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends notification when stream turns OFF", async () => {
    const healthy = createState();
    const stopped = createState({ streaming: false });
    const { monitor, notifyIncident, setCurrentState } = setup(healthy);

    await monitor.initialize();
    setCurrentState(stopped);

    await monitor.onVoiceStateUpdate(healthy, stopped);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(notifyIncident).toHaveBeenCalledTimes(1);
  });

  it("sends notification when user leaves VC", async () => {
    const healthy = createState();
    const leftVc = createState({ channelId: null, streaming: false });
    const { monitor, notifyIncident, setCurrentState } = setup(healthy);

    await monitor.initialize();
    setCurrentState(leftVc);

    await monitor.onVoiceStateUpdate(healthy, leftVc);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(notifyIncident).toHaveBeenCalledTimes(1);
  });

  it("skips notification when stream recovers within debounce window", async () => {
    const healthy = createState();
    const stopped = createState({ streaming: false });
    const recovered = createState();
    const { monitor, notifyIncident, setCurrentState } = setup(healthy);

    await monitor.initialize();

    setCurrentState(stopped);
    await monitor.onVoiceStateUpdate(healthy, stopped);

    setCurrentState(recovered);
    await monitor.onVoiceStateUpdate(stopped, recovered);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(notifyIncident).toHaveBeenCalledTimes(0);
  });

  it("does not send duplicate notifications while already stopped", async () => {
    const healthy = createState();
    const stopped = createState({ streaming: false });
    const { monitor, notifyIncident, setCurrentState } = setup(healthy);

    await monitor.initialize();

    setCurrentState(stopped);
    await monitor.onVoiceStateUpdate(healthy, stopped);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    setCurrentState(stopped);
    await monitor.onVoiceStateUpdate(healthy, stopped);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(notifyIncident).toHaveBeenCalledTimes(1);
  });

  it("sends notification again after recovery and next stop", async () => {
    const healthy = createState();
    const stopped = createState({ streaming: false });
    const { monitor, notifyIncident, setCurrentState } = setup(healthy);

    await monitor.initialize();

    setCurrentState(stopped);
    await monitor.onVoiceStateUpdate(healthy, stopped);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    setCurrentState(healthy);
    await monitor.onVoiceStateUpdate(stopped, healthy);

    setCurrentState(stopped);
    await monitor.onVoiceStateUpdate(healthy, stopped);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(notifyIncident).toHaveBeenCalledTimes(2);
  });

  it("ignores non-target guild/user updates", async () => {
    const healthy = createState();
    const { monitor, notifyIncident } = setup(healthy);

    const otherUserOld = createState({ userId: "user-2" });
    const otherUserNew = createState({ userId: "user-2", streaming: false });

    await monitor.initialize();
    await monitor.onVoiceStateUpdate(otherUserOld, otherUserNew);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(notifyIncident).toHaveBeenCalledTimes(0);
  });

  it("sends startup notification when user is already stopped", async () => {
    const stopped = createState({ streaming: false });
    const { monitor, notifyIncident } = setup(stopped);

    await monitor.initialize();

    expect(notifyIncident).toHaveBeenCalledTimes(1);
  });
});
