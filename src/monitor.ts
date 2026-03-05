import type { Logger } from "./logger.js";

export interface VoiceStateSnapshot {
  guildId: string;
  userId: string;
  channelId: string | null;
  streaming: boolean;
}

export interface MonitorDependencies {
  guildId: string;
  watchUserId: string;
  debounceMs: number;
  fetchCurrentState: () => Promise<VoiceStateSnapshot>;
  notifyIncident: () => Promise<void>;
  logger: Logger;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

function isInVoiceChannel(state: VoiceStateSnapshot): boolean {
  return Boolean(state.channelId);
}

export function isStopped(state: VoiceStateSnapshot): boolean {
  return !state.streaming || !isInVoiceChannel(state);
}

export function isRecovered(state: VoiceStateSnapshot): boolean {
  return state.streaming && isInVoiceChannel(state);
}

export class StreamMonitor {
  private readonly guildId: string;
  private readonly watchUserId: string;
  private readonly debounceMs: number;
  private readonly fetchCurrentState: () => Promise<VoiceStateSnapshot>;
  private readonly notifyIncident: () => Promise<void>;
  private readonly logger: Logger;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private incidentActive = false;
  private timerHandle: unknown | null = null;

  constructor(deps: MonitorDependencies) {
    this.guildId = deps.guildId;
    this.watchUserId = deps.watchUserId;
    this.debounceMs = deps.debounceMs;
    this.fetchCurrentState = deps.fetchCurrentState;
    this.notifyIncident = deps.notifyIncident;
    this.logger = deps.logger;
    this.setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  async initialize(): Promise<void> {
    const current = await this.fetchCurrentState();
    this.ensureTargetState(current, "initialize");

    if (!isStopped(current)) {
      this.incidentActive = false;
      this.logger.info("Monitor initialized: target user is currently healthy.");
      return;
    }

    this.logger.warn("Target user is already stopped at startup. Sending incident notification.");
    await this.sendIncidentIfNeeded("startup");
  }

  async onVoiceStateUpdate(oldState: VoiceStateSnapshot, newState: VoiceStateSnapshot): Promise<void> {
    if (!this.isTargetState(oldState) && !this.isTargetState(newState)) {
      return;
    }

    if (isRecovered(newState)) {
      this.clearPendingTimer();
      if (this.incidentActive) {
        this.logger.info("Target user recovered. Incident state reset.");
      }
      this.incidentActive = false;
    }

    const streamJustEnded = oldState.streaming && !newState.streaming;
    const vcJustLeft = Boolean(oldState.channelId) && !Boolean(newState.channelId);

    if (!streamJustEnded && !vcJustLeft) {
      return;
    }

    this.scheduleStopCheck();
  }

  private scheduleStopCheck(): void {
    this.clearPendingTimer();
    this.timerHandle = this.setTimer(() => {
      void this.checkStopState();
    }, this.debounceMs);
  }

  private clearPendingTimer(): void {
    if (this.timerHandle === null) {
      return;
    }
    this.clearTimer(this.timerHandle);
    this.timerHandle = null;
  }

  private async checkStopState(): Promise<void> {
    this.timerHandle = null;

    try {
      const current = await this.fetchCurrentState();
      this.ensureTargetState(current, "checkStopState");

      if (!isStopped(current)) {
        this.incidentActive = false;
        this.logger.info("Stop signal recovered during debounce window. Notification skipped.");
        return;
      }

      await this.sendIncidentIfNeeded("event");
    } catch (error) {
      this.logger.error("Failed to evaluate stop state.", error);
    }
  }

  private async sendIncidentIfNeeded(reason: "startup" | "event"): Promise<void> {
    if (this.incidentActive) {
      this.logger.info("Incident already active. Duplicate notification skipped.");
      return;
    }

    try {
      await this.notifyIncident();
      this.incidentActive = true;
      this.logger.warn(`Incident notification sent (${reason}).`);
    } catch (error) {
      this.logger.error("Failed to send incident notification.", error);
    }
  }

  private isTargetState(state: VoiceStateSnapshot): boolean {
    return state.guildId === this.guildId && state.userId === this.watchUserId;
  }

  private ensureTargetState(state: VoiceStateSnapshot, context: string): void {
    if (this.isTargetState(state)) {
      return;
    }

    throw new Error(
      `Unexpected watch state in ${context}. Expected guild=${this.guildId} user=${this.watchUserId}, received guild=${state.guildId} user=${state.userId}`,
    );
  }
}
