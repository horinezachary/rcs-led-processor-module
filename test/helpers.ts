import { Monitor } from '../src/monitor.js';
import type { Driver } from '../src/drivers/types.js';
import type { ProcessorConfig } from '../src/shared.js';
import { DEFAULT_THRESHOLDS } from '../src/thresholds.js';

/** A monitor for the given processors that polls only when asked (pollOnce). */
export function monitorFor(processors: ProcessorConfig[], opts: { requestTimeoutMs?: number; dataDir?: string; driverFactory?: (p: ProcessorConfig) => Driver | undefined } = {}): Monitor {
  const m = new Monitor({ pollIntervalMs: 60_000, requestTimeoutMs: opts.requestTimeoutMs ?? 3000, thresholds: DEFAULT_THRESHOLDS, dataDir: opts.dataDir, driverFactory: opts.driverFactory });
  m.setProcessors(processors);
  return m;
}
