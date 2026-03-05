export interface Logger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

function emit(level: "log" | "warn" | "error", scope: string, message: string, meta?: unknown): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${scope}] ${message}`;
  if (meta === undefined) {
    console[level](line);
    return;
  }
  console[level](line, meta);
}

export function createLogger(scope = "watchdog"): Logger {
  return {
    info(message, meta) {
      emit("log", scope, message, meta);
    },
    warn(message, meta) {
      emit("warn", scope, message, meta);
    },
    error(message, meta) {
      emit("error", scope, message, meta);
    },
  };
}
