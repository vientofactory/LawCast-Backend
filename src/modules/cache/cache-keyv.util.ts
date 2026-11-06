import { Logger } from '@nestjs/common';
import { createKeyv } from '@keyv/redis';
import Keyv from 'keyv';

/** Bridges cache-manager 7 and Nest's Keyv 5 detection to the Keyv 6 API. */
export function adaptKeyv6Store(store: Keyv): Keyv {
  const get = store.get.bind(store);
  const compatibleGet = (key: string, options?: { raw?: boolean }) =>
    options?.raw ? store.getRaw(key) : get(key);
  store.get = compatibleGet as typeof store.get;
  // Nest uses these legacy fields for identity detection, not configuration.
  Object.defineProperty(store, 'opts', { value: {}, configurable: true });
  if (!('hooks' in store)) {
    Object.defineProperty(store, 'hooks', { value: {}, configurable: true });
  }
  store.on('error', (error: Error) => {
    Logger.warn(`Cache store error: ${error.message}`, 'CacheStore');
  });
  return store;
}

export function createRedisCacheStore(url: string, namespace: string): Keyv {
  return adaptKeyv6Store(createKeyv(url, { namespace }));
}
