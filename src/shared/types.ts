// Shared cross-module types — authoritative source for the data model.
// No module imports from outside src/shared/types except as needed for type
// definitions; this module holds no behavior (Constitution Principle II).

export type ProcessPhase = 'starting' | 'running' | 'shutting-down' | 'stopped';

export type ConnectionState = 'disconnected' | 'connected' | 'reconnecting' | 'destroyed';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export type Config = Readonly<{
  discordToken: string;
  logLevel: LogLevel;
  commandPrefix: string;
  echoCommandName: string;
  echoMaxLength: number;
  shutdownTimeoutMs: number;
  healthHost: string;
  healthPort: number;
}>;

export type BotState = {
  phase: ProcessPhase;
  discord: ConnectionState;
  startedAt: number;
  lastStateChangeAt: number;
};

export type UserCommand = {
  correlationId: string;
  userId: string;
  guildId: string | null;
  channelId: string;
  rawContent: string;
  commandName: string;
  args: string;
  receivedAt: number;
};

export type EchoResult =
  | { status: 'echoed'; reply: string }
  | { status: 'too-long'; reply: string }
  | { status: 'usage-hint'; reply: string };

export type HealthStatus = {
  status: 'healthy' | 'degraded' | 'shutting-down' | 'unhealthy';
  phase: ProcessPhase;
  discord: ConnectionState;
  uptimeMs: number;
  checkedAt: number;
};
