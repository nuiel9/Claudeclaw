import EventEmitter from "eventemitter3";
import type { ClaudeclawEvent, Logger } from "./types.js";

type EventMap = {
  [K in ClaudeclawEvent["type"]]: [Extract<ClaudeclawEvent, { type: K }>];
};

export class ClaudeclawEventBus {
  private emitter = new EventEmitter();
  private logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  emit<T extends ClaudeclawEvent["type"]>(
    type: T,
    event: Extract<ClaudeclawEvent, { type: T }>
  ): void {
    this.logger?.debug(`Event: ${type}`, event as Record<string, unknown>);
    this.emitter.emit(type, event);
  }

  on<T extends ClaudeclawEvent["type"]>(
    type: T,
    handler: (event: Extract<ClaudeclawEvent, { type: T }>) => void
  ): void {
    this.emitter.on(type, handler as (...args: unknown[]) => void);
  }

  off<T extends ClaudeclawEvent["type"]>(
    type: T,
    handler: (event: Extract<ClaudeclawEvent, { type: T }>) => void
  ): void {
    this.emitter.off(type, handler as (...args: unknown[]) => void);
  }

  once<T extends ClaudeclawEvent["type"]>(
    type: T,
    handler: (event: Extract<ClaudeclawEvent, { type: T }>) => void
  ): void {
    this.emitter.once(type, handler as (...args: unknown[]) => void);
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}

export const globalEventBus = new ClaudeclawEventBus();
