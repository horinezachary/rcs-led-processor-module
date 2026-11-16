// Alert limits. They are the module's own settings (config), so named saves carry them.

export interface Thresholds {
  /** Any processor temperature at or above this is a warning, in °C. */
  tempWarnC: number;
  /** ...and at or above this, critical. */
  tempCritC: number;
  /** A running fan below this speed is a warning, in RPM. 0 turns the check off. */
  fanMinRpm: number;
  /** Any tile or cabinet (its receiving card) at or above this is a warning, in °C. */
  tileTempWarnC: number;
  /** ...and at or above this, critical. */
  tileTempCritC: number;
  /** Share of tiles offline that turns the tile warning critical, in percent. */
  tilesOfflineCritPercent: number;
  /** Missed polls before a processor counts as unreachable (critical). One missed poll is a warning. */
  unreachableAfterPolls: number;
  /** Port load that raises a warning, in percent (COEX). Over 100% is critical. */
  portLoadWarnPercent: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  tempWarnC: 70,
  tempCritC: 80,
  fanMinRpm: 500,
  tileTempWarnC: 65,
  tileTempCritC: 75,
  tilesOfflineCritPercent: 5,
  unreachableAfterPolls: 3,
  portLoadWarnPercent: 90
};

/** Lowest and highest value each limit takes, for checking what the web view or a save sends. */
export const THRESHOLD_RANGES: Record<keyof Thresholds, [number, number]> = {
  tempWarnC: [20, 120],
  tempCritC: [20, 130],
  fanMinRpm: [0, 20000],
  tileTempWarnC: [20, 120],
  tileTempCritC: [20, 130],
  tilesOfflineCritPercent: [0, 100],
  unreachableAfterPolls: [1, 20],
  portLoadWarnPercent: [10, 200]
};

/** Fills in missing or out-of-range limits from the defaults. */
export function cleanThresholds(t: unknown): Thresholds {
  const o = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_THRESHOLDS };
  for (const k of Object.keys(DEFAULT_THRESHOLDS) as (keyof Thresholds)[]) {
    const v = o[k];
    const [lo, hi] = THRESHOLD_RANGES[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi) out[k] = v;
  }
  return out;
}
