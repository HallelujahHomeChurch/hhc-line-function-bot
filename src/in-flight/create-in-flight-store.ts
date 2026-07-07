import {
  MemoryInFlightStore,
  RedisInFlightStore,
  type InFlightStore,
  type RedisInFlightClient
} from "./in-flight-store.js";

export interface InFlightStoreFactoryOptions {
  redis?: {
    client: RedisInFlightClient;
    keyPrefix: string;
  };
}

export function createInFlightStore(options: InFlightStoreFactoryOptions): InFlightStore {
  if (options.redis) {
    return new RedisInFlightStore(options.redis);
  }
  return new MemoryInFlightStore();
}
