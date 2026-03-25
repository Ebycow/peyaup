import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../src/logger.js";
import { syncSlashCommandScope } from "../src/slash-command-registration.js";

function createLoggerStub(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createCommandScope(existingCommands: Array<{ id: string; name: string }>) {
  return {
    fetchExistingCommands: vi.fn(async () => ({
      values: () => existingCommands.values(),
    })),
    replaceCommands: vi.fn(
      async (_payloads: readonly Array<{ name: string; description: string }>) => undefined,
    ),
    scopeLabel: "guild 762717772655493160",
  };
}

describe("syncSlashCommandScope", () => {
  it("replaces the scope with the desired commands and logs stale removals", async () => {
    const logger = createLoggerStub();
    const commands = createCommandScope([
      { id: "cmd-spin-old-1", name: "spin" },
      { id: "cmd-buy-old", name: "buy" },
      { id: "cmd-rank-old", name: "rank" },
    ]);

    await syncSlashCommandScope(
      commands,
      [
        { name: "spin", description: "spin command" },
        { name: "tv", description: "tv command" },
      ],
      logger,
    );

    expect(commands.replaceCommands).toHaveBeenCalledOnce();
    expect(commands.replaceCommands).toHaveBeenCalledWith([
      {
        name: "spin",
        description: "spin command",
      },
      {
        name: "tv",
        description: "tv command",
      },
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      "Removed stale guild 762717772655493160 slash command /buy.",
    );
    expect(logger.info).toHaveBeenCalledWith(
      "Removed stale guild 762717772655493160 slash command /rank.",
    );
    expect(logger.info).toHaveBeenCalledWith(
      "Synced guild 762717772655493160 slash commands: /spin, /tv.",
    );
  });

  it("clears a scope when no commands should remain", async () => {
    const logger = createLoggerStub();
    const commands = {
      ...createCommandScope([{ id: "cmd-show-old", name: "show" }]),
      scopeLabel: "global",
    };

    await syncSlashCommandScope(
      commands,
      [],
      logger,
    );

    expect(commands.replaceCommands).toHaveBeenCalledOnce();
    expect(commands.replaceCommands).toHaveBeenCalledWith([]);
    expect(logger.info).toHaveBeenCalledWith("Removed stale global slash command /show.");
    expect(logger.info).toHaveBeenCalledWith("Cleared global slash commands.");
  });
});
