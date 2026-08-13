export type LogContext = Readonly<Record<string, unknown>>;
export type LogArgument = string | LogContext;

export interface LoggerPlatform {
  trace(value: LogArgument, message?: string): void;
  debug(value: LogArgument, message?: string): void;
  info(value: LogArgument, message?: string): void;
  warn(value: LogArgument, message?: string): void;
  error(value: LogArgument, message?: string): void;
  child(bindings: LogContext): LoggerPlatform;
}

export type LoggerAdapter = LoggerPlatform;

