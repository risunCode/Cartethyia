import type { LogLevel } from "../application/logging";

export interface LogSink {
  push(level: LogLevel, scope: string, msg: string): void;
}

export interface ApplicationLogger {
  web(level: LogLevel, message: string): void;
  request(level: LogLevel, message: string): void;
  system(level: LogLevel, scope: string, message: string): void;
}

export function createApplicationLogger(sink: LogSink): ApplicationLogger {
  return {
    web(level, message) {
      sink.push(level, "web", message);
    },
    request(level, message) {
      sink.push(level, "request", message);
    },
    system(level, scope, message) {
      sink.push(level, scope, message);
    },
  };
}
