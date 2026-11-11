export interface ChainAuditLimits {
  timeoutMs: number;
  heapMb: number;
  rssMb: number;
  dutyPercent: number;
  batchSize: number;
}

export const MAX_AUDIT_FAILURES = 100;

export function readChainAuditLimits(env: NodeJS.ProcessEnv): ChainAuditLimits {
  const read = (name: string, fallback: number, min: number, max: number) => {
    const value = Number(env[name]);
    return Number.isSafeInteger(value) && value >= min
      ? Math.min(value, max)
      : fallback;
  };
  return {
    timeoutMs: read('CHAIN_AUDIT_TIMEOUT_MS', 1_800_000, 1000, 7_200_000),
    heapMb: read('CHAIN_AUDIT_HEAP_MB', 192, 64, 512),
    rssMb: read('CHAIN_AUDIT_RSS_MB', 512, 128, 1024),
    dutyPercent: read('CHAIN_AUDIT_DUTY_PERCENT', 25, 1, 50),
    batchSize: read('CHAIN_AUDIT_BATCH_SIZE', 50, 1, 100),
  };
}
