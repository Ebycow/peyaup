import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord-api-types/v10";
import type { Logger } from "./logger.js";

interface ExistingGuildCommand {
  id: string;
  name: string;
}

interface FetchedGuildCommands {
  values(): Iterable<ExistingGuildCommand>;
}

interface SlashCommandScopeRegistrar {
  fetchExistingCommands(): Promise<FetchedGuildCommands>;
  replaceCommands(payloads: readonly RESTPostAPIChatInputApplicationCommandsJSONBody[]): Promise<unknown>;
  scopeLabel: string;
}

export type SlashCommandPayload = RESTPostAPIChatInputApplicationCommandsJSONBody;

export async function syncSlashCommandScope(
  registrar: SlashCommandScopeRegistrar,
  payloads: readonly SlashCommandPayload[],
  logger: Logger,
): Promise<void> {
  const existingCommands = await registrar.fetchExistingCommands();
  const existingNames = new Set<string>();

  for (const command of existingCommands.values()) {
    existingNames.add(command.name);
  }

  await registrar.replaceCommands(payloads);

  const desiredNames = new Set(payloads.map((payload) => payload.name));
  for (const existingName of existingNames) {
    if (!desiredNames.has(existingName)) {
      logger.info(`Removed stale ${registrar.scopeLabel} slash command /${existingName}.`);
    }
  }

  if (payloads.length === 0) {
    logger.info(`Cleared ${registrar.scopeLabel} slash commands.`);
    return;
  }

  const commandList = payloads.map((payload) => `/${payload.name}`).join(", ");
  logger.info(`Synced ${registrar.scopeLabel} slash commands: ${commandList}.`);
}
