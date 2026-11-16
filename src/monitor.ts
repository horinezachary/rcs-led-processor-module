// Polls every processor on its own timer, keeps the latest reading and alerts for each in memory, and
// records every change of state as an event. Listeners hear 'change' after each poll and 'event' for
// each new event. Ported from LEDScreenControl's monitor, without its files: nothing read from a
// processor is written to disk, so a restart or a restored save always starts from what the
// processors say now.
//
// Polling only reads. control() is the one way anything is sent, and the module calls it only on an
// operator's confirmed action.
import { EventEmitter } from 'node:events';
import type { Alert, ControlRequest, ProcessorConfig, ProcessorSnapshot, ProcessorView } from './shared.js';
import type { Driver } from './drivers/types.js';
import { bromptonDriver } from './drivers/brompton.js';
import { coexDriver } from './drivers/coex.js';
import { deviceDriver } from './drivers/device.js';
import { vxproDriver } from './drivers/vxpro.js';
import { evaluate, loopAlerts, markHotTiles } from './rules.js';
import type { Thresholds } from './thresholds.js';

export interface MonitorEvent {
  id: number;
  time: number;
  processorId?: string;
  level: 'info' | 'ok' | 'warning' | 'critical';
  message: string;
  /** The module's own rules (default), or a control action. */
  source?: 'monitor' | 'control';
}

export interface MonitorOptions {
  pollIntervalMs: number;
  requestTimeoutMs: number;
  thresholds: Thresholds;
  /** Where the COEX error count resets are kept (the module's data folder). */
  dataDir?: string;
  /** For tests: a driver per processor. */
  driverFactory?: (p: ProcessorConfig) => Driver | undefined;
}

/** dataDir keeps what a driver must remember across restarts (COEX error count resets). */
export function driverFor(p: ProcessorConfig, dataDir?: string): Driver | undefined {
  if (p.kind === 'brompton') return bromptonDriver(p);
  if (p.kind === 'coex') return coexDriver(p, { dataDir });
  if (p.kind === 'vxpro') return vxproDriver(p, { dataDir });
  if (p.kind === 'device') return deviceDriver(p);
  return undefined;
}

/** A short history for the sparklines: hottest processor temperature and brightness, one point per poll. */
export interface HistoryPoint {
  t: number;
  temp?: number;
  tileTemp?: number;
}

const HISTORY_POINTS = 72; // six minutes at one poll every 5 s
const EVENTS_KEPT = 300;

interface Entry {
  config: ProcessorConfig;
  driver?: Driver;
  view: ProcessorView;
  loopsSeen: Map<string, string>;
  history: HistoryPoint[];
  timer?: NodeJS.Timeout;
  inFlight?: AbortController;
  removed?: boolean;
}

export class ControlError extends Error {}

export class Monitor extends EventEmitter {
  private entries = new Map<string, Entry>();
  private stopped = true;
  private events: MonitorEvent[] = [];
  private nextEventId = 1;

  constructor(private opts: MonitorOptions) {
    super();
  }

  get thresholds(): Thresholds {
    return this.opts.thresholds;
  }

  set thresholds(t: Thresholds) {
    this.opts.thresholds = t;
  }

  /**
   * Makes the polled list match the module's config: processors that are gone stop being polled, new and
   * changed ones start. Only ever reads.
   */
  setProcessors(list: ProcessorConfig[]): void {
    const wanted = new Map(list.map((p) => [p.id, p]));
    for (const [id, e] of this.entries) {
      const next = wanted.get(id);
      if (!next || JSON.stringify(next) !== JSON.stringify(e.config)) this.drop(e);
    }
    let i = 0;
    for (const p of list) {
      if (this.entries.has(p.id)) continue;
      const driver = (this.opts.driverFactory ?? ((c) => driverFor(c, this.opts.dataDir)))(p);
      const entry: Entry = { config: p, driver, view: emptyView(p, driver), loopsSeen: new Map(), history: [] };
      this.entries.set(p.id, entry);
      // Spread the first polls out a little so a big show network is not hit all at once.
      if (!this.stopped && driver) entry.timer = setTimeout(() => void this.pollLoop(entry), Math.min(i++ * 150, this.opts.pollIntervalMs));
    }
    // Keep the configured order.
    this.entries = new Map(list.filter((p) => this.entries.has(p.id)).map((p) => [p.id, this.entries.get(p.id)!]));
    this.emit('change');
  }

  start(): void {
    this.stopped = false;
    let i = 0;
    for (const e of this.entries.values()) {
      if (!e.driver || e.timer) continue;
      e.timer = setTimeout(() => void this.pollLoop(e), Math.min(i++ * 150, this.opts.pollIntervalMs));
    }
  }

  stop(): void {
    this.stopped = true;
    for (const e of this.entries.values()) {
      clearTimeout(e.timer);
      e.timer = undefined;
      e.inFlight?.abort();
    }
    this.removeAllListeners();
  }

  /** Polls every processor now (Reconnect). Reads only. */
  pollAll(): void {
    for (const e of this.entries.values()) {
      if (!e.driver || this.stopped) continue;
      clearTimeout(e.timer);
      e.timer = setTimeout(() => void this.pollLoop(e), 0);
    }
  }

  views(): ProcessorView[] {
    return [...this.entries.values()].map((e) => e.view);
  }

  view(id: string): ProcessorView | undefined {
    return this.entries.get(id)?.view;
  }

  history(id: string): HistoryPoint[] {
    return this.entries.get(id)?.history ?? [];
  }

  recentEvents(n = 100, processorId?: string): MonitorEvent[] {
    const list = processorId ? this.events.filter((e) => e.processorId === processorId) : this.events;
    return list.slice(-n).reverse();
  }

  addEvent(e: Omit<MonitorEvent, 'id' | 'time'> & { time?: number }): MonitorEvent {
    const ev: MonitorEvent = { id: this.nextEventId++, time: e.time ?? Date.now(), ...e };
    this.events.push(ev);
    if (this.events.length > EVENTS_KEPT) this.events.splice(0, this.events.length - EVENTS_KEPT);
    this.emit('event', ev);
    return ev;
  }

  /** Polls one processor once. Exposed for tests; the loop calls it on a timer. */
  async pollOnce(id: string): Promise<ProcessorView> {
    const e = this.entries.get(id);
    if (!e) throw new Error(`No processor "${id}"`);
    await this.poll(e);
    return e.view;
  }

  /**
   * Sends one control command to a processor, records it, then reads the processor again so every screen
   * shows what the processor now says, never a guess. Throws ControlError with a message for the operator.
   * The caller has already checked that controls are allowed and that the operator confirmed.
   */
  async control(id: string, req: ControlRequest, who: string): Promise<ProcessorView> {
    const entry = this.entries.get(id);
    if (!entry) throw new ControlError('That processor is not in the list.');
    const v = entry.view;
    const caps = entry.driver?.capabilities;
    if (!entry.driver?.control || !caps || !caps[req.action]) throw new ControlError(`${v.name} does not take ${req.action} from this module.`);
    if (!v.reachable && req.action !== 'resetErrors') throw new ControlError(`${v.name} is not answering.`);
    if (req.action === 'brightness' && caps.brightness) {
      const { min, max } = caps.brightness;
      if (!Number.isFinite(req.value) || req.value < min || req.value > max) throw new ControlError(`Brightness must be from ${min} to ${max}.`);
    }
    if (req.action === 'input' && !v.inputs.some((i) => i.key === req.value)) throw new ControlError('That input is not on this processor.');
    if (req.action === 'preset' && v.presets && !v.presets.some((p) => p.number === req.value)) throw new ControlError('That preset is not on this processor.');
    const what = describe(req, v);
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), this.opts.requestTimeoutMs);
    try {
      await entry.driver.control(req, ctrl.signal);
    } catch (err) {
      const msg = ctrl.signal.aborted ? `no answer within ${this.opts.requestTimeoutMs / 1000} s` : (err as Error).message;
      this.addEvent({ processorId: id, level: 'warning', source: 'control', message: `${v.name}: ${what} failed (${msg}), from ${who}` });
      throw new ControlError(`${v.name} did not take it: ${msg}`);
    } finally {
      clearTimeout(timeout);
    }
    this.addEvent({ processorId: id, level: 'info', source: 'control', message: `${v.name}: ${what}, from ${who}` });
    if (!entry.removed) await this.poll(entry);
    return entry.view;
  }

  private drop(e: Entry): void {
    e.removed = true;
    clearTimeout(e.timer);
    e.inFlight?.abort();
    this.entries.delete(e.config.id);
  }

  private async pollLoop(entry: Entry): Promise<void> {
    if (this.stopped || entry.removed) return;
    await this.poll(entry);
    if (this.stopped || entry.removed) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => void this.pollLoop(entry), this.opts.pollIntervalMs);
  }

  private async poll(entry: Entry): Promise<void> {
    if (!entry.driver) return;
    const ctrl = new AbortController();
    entry.inFlight = ctrl;
    const timeout = setTimeout(() => ctrl.abort(), this.opts.requestTimeoutMs);
    const prev = entry.view;
    let snap: ProcessorSnapshot;
    try {
      const data = await entry.driver.poll(ctrl.signal);
      const { reportedName, ...rest } = data;
      snap = {
        ...rest,
        id: entry.config.id,
        kind: entry.config.kind,
        host: entry.config.host,
        name: entry.config.name || reportedName || entry.config.host,
        reachable: true,
        lastSeen: Date.now(),
        missedPolls: 0
      };
    } catch (err) {
      if (entry.removed) return;
      const message = ctrl.signal.aborted ? `no answer within ${this.opts.requestTimeoutMs / 1000} s` : errorText(err);
      // Keep the last known readings on screen, marked unreachable.
      snap = { ...stripView(prev), reachable: false, lastError: message, missedPolls: prev.missedPolls + 1 };
    } finally {
      clearTimeout(timeout);
      if (entry.inFlight === ctrl) entry.inFlight = undefined;
    }
    if (entry.removed) return;
    const t = this.opts.thresholds;
    const extra = loopAlerts(snap, entry.loopsSeen);
    const { alerts, severity } = evaluate(snap, t, prev.alerts, Date.now(), extra);
    const topology = markHotTiles(snap.topology, snap.tileTemperatures, t);
    entry.view = { ...snap, topology, alerts, severity, controls: entry.driver.capabilities };
    if (entry.view.reachable) {
      const temps = entry.view.temperatures.map((r) => r.value);
      const tiles = (entry.view.tileTemperatures ?? []).map((r) => r.value);
      entry.history.push({ t: Date.now(), temp: temps.length ? Math.max(...temps) : undefined, tileTemp: tiles.length ? Math.max(...tiles) : undefined });
      if (entry.history.length > HISTORY_POINTS) entry.history.splice(0, entry.history.length - HISTORY_POINTS);
    }
    this.logChanges(entry.view, prev);
    this.emit('change', entry.view);
  }

  private logChanges(now: ProcessorView, before: ProcessorView): void {
    const name = now.name;
    if (now.reachable && before.lastSeen === undefined) {
      this.addEvent({ processorId: now.id, level: 'info', message: `${name}: connected (${now.model ?? now.kind}, ${now.firmware ?? 'firmware unknown'})` });
    } else if (now.reachable && !before.reachable && before.missedPolls > 0) {
      this.addEvent({ processorId: now.id, level: 'ok', message: `${name}: responding again` });
    }
    const was = new Map(before.alerts.map((a) => [a.key, a]));
    const is = new Map(now.alerts.map((a) => [a.key, a]));
    for (const a of now.alerts) {
      const old = was.get(a.key);
      if (!old || old.severity !== a.severity) this.addEvent({ processorId: now.id, level: a.severity, message: `${name}: ${a.message}` });
    }
    for (const a of before.alerts) {
      if (!is.has(a.key)) this.addEvent({ processorId: now.id, level: 'ok', message: `${name}: cleared, ${lowerFirst(a.message)}` });
    }
    if (now.reachable && before.reachable && now.preset && before.preset && now.preset.number !== before.preset.number) {
      this.addEvent({ processorId: now.id, level: 'info', message: `${name}: preset ${now.preset.number} "${now.preset.name}" loaded` });
    }
  }
}

function emptyView(p: ProcessorConfig, driver: Driver | undefined): ProcessorView {
  return {
    id: p.id,
    name: p.name || p.host,
    kind: p.kind,
    host: p.host,
    reachable: false,
    missedPolls: 0,
    temperatures: [],
    fans: [],
    inputs: [],
    loops: [],
    severity: 'unknown',
    alerts: [],
    lastError: driver ? undefined : `No driver for ${p.kind} processors.`,
    controls: driver?.capabilities
  };
}

function stripView(v: ProcessorView): ProcessorSnapshot {
  const { alerts: _a, severity: _s, ...snap } = v;
  return snap;
}

export function describe(req: ControlRequest, p: ProcessorView): string {
  switch (req.action) {
    case 'brightness':
      return `brightness set to ${req.value}${(p.controls?.brightness?.unit ?? p.brightnessUnit) === '%' ? '%' : ' nits'}`;
    case 'blackout':
      return req.value ? 'blackout on' : 'blackout off';
    case 'freeze':
      return req.value ? 'freeze on' : 'freeze off';
    case 'preset': {
      const name = p.presets?.find((x) => x.number === req.value)?.name;
      return `preset ${req.value}${name ? ` "${name}"` : ''} loaded`;
    }
    case 'input':
      return `input switched to ${p.inputs.find((i) => i.key === req.value)?.label ?? req.value}`;
    case 'failover':
      return 'failover requested';
    case 'reboot':
      return 'reboot requested';
    case 'resetErrors':
      return 'receiving card error counts reset in this module';
  }
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    // fetch puts the socket error under cause; a raw socket (VX Pro) puts it on the error itself.
    const code = (err as Error & { cause?: { code?: string } }).cause?.code ?? (err as NodeJS.ErrnoException).code;
    if (code === 'ECONNREFUSED') return 'connection refused (is IP control enabled?)';
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'host unreachable';
    if (code) return code;
    return err.message;
  }
  return String(err);
}

export type { Alert };
