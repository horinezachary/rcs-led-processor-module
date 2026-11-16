// LED Processor Monitor: watches Brompton Tessera and NovaStar (COEX, VX Pro) LED processors on the show
// network, ported from LEDScreenControl. Health rules turn each reading into alerts; the panel shows
// every processor, its alerts, its cable loops, tiles and output ports, a topology diagram of each wall,
// and the Stream Deck holds the controls for the selected processor.
//
// The processors are the source of truth. Everything read from them is kept only in memory: state holds
// which processor the panel shows, config holds the processor list, the alert limits, the Brompton wall
// layouts and the Allow controls switch. Starting, restoring a save, resuming after a power cut and reconnecting only read.
// A command (preset, brightness, freeze, blackout, input, failover, reboot) goes out only when the
// operator asks, only with Allow controls on, and only after a confirmation: a second press of the same
// key within 3 seconds on the Stream Deck, a dialog in the web view.
//
// The processors' IP control APIs take no login, so the module holds no secrets.
//
// Stream Deck:
//   keys 1-4   processors (key 4 pages when there are more than 4); press to select
//   key 5      alerts: the count, press for the Alerts view
//   keys 6-8   presets of the selected processor (key 13 pages through more)
//   keys 9/10  brightness down / up one step
//   key 11     freeze on / off
//   key 15     blackout on / off
//   Every command key needs a second press within 3 s.

import { randomBytes } from 'node:crypto';
import { defineModule, type Ctx, type KeySetParams } from '@rcs/module-sdk';
import { ControlError, Monitor, describe, type MonitorEvent } from './monitor.js';
import { identify, isSubnet, localSubnets } from './scan.js';
import { type ControlRequest, type ProcessorConfig, type ProcessorKind, type ProcessorView, type Severity, type WallLayout, type WallView, tileTemperatureSummary, wallGroupsFromLoops, worstSeverity } from './shared.js';
import { cleanThresholds, DEFAULT_THRESHOLDS, THRESHOLD_RANGES, type Thresholds } from './thresholds.js';
import { Topology } from './topology.js';
import { cleanWalls, parseWalls, WallError } from './walls.js';

export interface State {
  /** Id of the processor the panel and keys work on. */
  proc: string;
}

export interface ProcessorEntry {
  id: string;
  kind: ProcessorKind;
  host: string;
  /** 0: the kind's usual port (Tessera 80, COEX 8001, VX Pro 15200, other devices 80). */
  port: number;
  /** Name to show instead of the one the processor reports. Empty: the processor's own name. */
  label: string;
  /** COEX: pixels one output port drives. 0: worked out from the port speed and frame rate the processor reports. */
  portCapacity: number;
}

export interface Config {
  processors: ProcessorEntry[];
  thresholds: Thresholds;
  /** How each Brompton wall is cabled. COEX walls come from the processor and need nothing here. */
  walls: WallLayout[];
  /** Lets the operator send commands. Off: the module only reads. */
  allowControls: boolean;
}

type C = Ctx<State, Config>;
export type View = 'overview' | 'alerts' | 'loops' | 'topology' | 'setup';
const VIEWS: View[] = ['overview', 'alerts', 'loops', 'topology', 'setup'];
const KINDS: ProcessorKind[] = ['brompton', 'coex', 'vxpro', 'device'];

export const KEY = { PROC: [0, 1, 2, 3], ALERTS: 4, PRESET: [5, 6, 7], DIM: 8, BRIGHT: 9, FREEZE: 10, PRESET_PAGE: 12, BLACKOUT: 14 } as const;
export const MAX_PROCESSORS = 12;
/** A command key fires on a second press within this time. */
export const CONFIRM_MS = 3000;
/** Read at each start, so tests and development can poll faster. */
const pollMs = () => Number(process.env.RCS_LED_POLL_MS) || 5000;
const timeoutMs = () => Number(process.env.RCS_LED_TIMEOUT_MS) || 3000;

const ACCENT = '#F5A524';
const ON_ACCENT = '#16181C';
const CRIT = '#7A2620';
const WARN = '#5A400E';
const ARMED = '#3A2A0E';
const BLUE = '#4C9AFF';
const RED = '#FF6B5E';

const SEV_TEXT: Record<Severity, string> = { ok: 'OK', warning: 'WARNING', critical: 'CRITICAL', unknown: 'UNKNOWN' };

interface Armed {
  key: number;
  proc: string;
  req: ControlRequest;
  timer: NodeJS.Timeout;
}

interface Found {
  host: string;
  port: number;
  kind: ProcessorKind;
  name?: string;
  model?: string;
  serial?: string;
}

interface Runtime {
  monitor: Monitor;
  topology: Topology;
  /** Built after every poll, so a broken loop is pinned to its chain whichever view is showing. */
  walls: WallView[];
  view: View;
  procPage: number;
  presetPage: number;
  armed: Armed | null;
  scanning: boolean;
  found: Found[];
  drawTimer: NodeJS.Timeout | null;
}
let rt: Runtime | null = null;

const ADDRESS_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$|^\[?[0-9A-Fa-f:]+\]?$/;
export const validAddress = (a: unknown): a is string => typeof a === 'string' && a !== '' && ADDRESS_RE.test(a);

function cleanEntry(p: any): ProcessorEntry | null {
  if (!p || typeof p.id !== 'string' || !KINDS.includes(p.kind) || !validAddress(p.host)) return null;
  const port = Number.isInteger(p.port) && p.port >= 0 && p.port <= 65535 ? p.port : 0;
  const cap = Number.isInteger(p.portCapacity) && p.portCapacity >= 0 ? p.portCapacity : 0;
  return { id: p.id, kind: p.kind, host: p.host, port, label: typeof p.label === 'string' ? p.label.slice(0, 40) : '', portCapacity: cap };
}

export function cfg(ctx: C): Config {
  const c = (ctx.config ?? {}) as Partial<Config>;
  const processors = Array.isArray(c.processors) ? c.processors.map(cleanEntry).filter((p): p is ProcessorEntry => !!p) : [];
  return {
    processors,
    thresholds: cleanThresholds(c.thresholds),
    walls: cleanWalls(c.walls, new Set(processors.map((p) => p.id))),
    allowControls: c.allowControls ?? false
  };
}

const toDriverConfig = (e: ProcessorEntry): ProcessorConfig => ({
  id: e.id,
  kind: e.kind,
  host: e.host,
  ...(e.label ? { name: e.label } : {}),
  ...(e.port ? { port: e.port } : {}),
  ...(e.portCapacity ? { portCapacity: e.portCapacity } : {})
});

const short = (s: string | undefined, n: number): string => [...(s ?? '')].slice(0, n).join('');
const quiet = (p: Promise<unknown>): void => void p.catch(() => {});
const views = (): ProcessorView[] => rt?.monitor.views() ?? [];

function current(ctx: C): ProcessorView | undefined {
  const list = views();
  return list.find((p) => p.id === ctx.state.value.proc) ?? list[0];
}

function overall(list: ProcessorView[]): Severity {
  const known = list.filter((p) => p.severity !== 'unknown').map((p) => p.severity);
  return list.length ? (known.length ? worstSeverity(known) : 'unknown') : 'unknown';
}

// ---- what the screens get ----------------------------------------------------------------------

function fmtUptime(s?: number): string {
  if (s === undefined) return '';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

function brightnessText(p: ProcessorView): string {
  if (p.brightness === undefined) return '';
  const unit = p.brightnessUnit ?? p.controls?.brightness?.unit ?? 'nits';
  return unit === '%' ? `${p.brightness}%` : `${Math.round(p.brightness).toLocaleString('en-US')} nits`;
}

/** One processor as the cards show it: no topology, which can be large. */
function summary(p: ProcessorView) {
  const active = p.inputs.find((i) => i.active);
  const hottest = p.temperatures.length ? p.temperatures.reduce((a, b) => (b.value > a.value ? b : a)) : undefined;
  const tt = tileTemperatureSummary(p.tileTemperatures);
  const running = p.fans.filter((f) => f.running).length;
  const f = p.failover;
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    host: p.host,
    model: p.model ?? '',
    serial: p.serial ?? '',
    firmware: p.firmware ?? '',
    uptime: fmtUptime(p.uptimeSeconds),
    reachable: p.reachable,
    lastError: p.lastError ?? '',
    lastSeen: p.lastSeen ?? 0,
    severity: p.severity,
    alerts: p.alerts,
    note: p.note ?? '',
    input: active ? `${active.label}${active.signal ? (active.width ? ` · ${active.width}×${active.height}` : '') + (active.rate ? ` · ${active.rate} Hz` : '') : ' · no signal'}` : '',
    inputOk: active ? active.signal : true,
    inputs: p.inputs,
    genlock: p.genlock ? `${p.genlock.source}${p.genlock.rate ? ` · ${p.genlock.rate} Hz` : ''}` : '',
    hottest: hottest ? { label: hottest.label, value: hottest.value } : null,
    temperatures: p.temperatures,
    tileTemp: tt ? { hottest: tt.hottest.value, hottestLabel: tt.hottest.label, average: Math.round(tt.average * 10) / 10, count: tt.count } : null,
    fans: p.fans.length ? `${running} of ${p.fans.length} running` : '',
    fansOk: p.fans.every((x) => x.running),
    fanList: p.fans,
    tiles: p.tiles ? { associated: p.tiles.associated, online: p.tiles.online, errors: p.tiles.errors, firmware: p.tiles.firmware } : null,
    redundancy: f?.enabled
      ? `${f.role ? f.role[0]!.toUpperCase() + f.role.slice(1) : 'Redundant'} · ${f.active ? (f.role === 'backup' ? 'driving the wall' : 'backup driving') : f.partnerPresent === false ? 'partner missing' : f.partnerPresent ? 'partner present' : 'standing by'}`
      : '',
    brightness: p.brightness ?? null,
    brightnessText: brightnessText(p),
    preset: p.preset ?? null,
    presets: p.presets ?? [],
    blackout: p.blackout ?? false,
    freeze: p.freeze ?? false,
    controls: p.controls ?? {},
    history: rt?.monitor.history(p.id).map((h) => [h.temp ?? null, h.tileTemp ?? null]) ?? []
  };
}

/** Loops, tiles and output ports of one processor, for the Loops view and the web page. */
function outputs(p: ProcessorView | undefined) {
  if (!p) return null;
  return { id: p.id, name: p.name, kind: p.kind, loops: p.loops, tiles: p.tiles ?? null, topology: p.topology ?? null, devices: p.devices ?? [], tileTemperatures: p.tileTemperatures ?? [] };
}

/** Paints the processors' latest readings onto the wall layouts, and adds each COEX processor's own wall. */
function refreshWalls(ctx: C): void {
  if (!rt) return;
  rt.walls = rt.topology.build(cfg(ctx).walls, new Map(views().map((p) => [p.id, p])));
}

function activeAlerts() {
  return views()
    .flatMap((p) => p.alerts.map((a) => ({ ...a, proc: p.id, procName: p.name })))
    .sort((a, b) => (a.severity === b.severity ? b.since - a.since : a.severity === 'critical' ? -1 : 1));
}

export function snapshot(ctx: C) {
  const c = cfg(ctx);
  const list = views();
  const cur = current(ctx);
  return {
    type: 'snapshot',
    view: rt?.view ?? 'overview',
    allowControls: c.allowControls,
    thresholds: c.thresholds,
    pollSeconds: pollMs() / 1000,
    severity: overall(list),
    processors: list.map(summary),
    entries: c.processors,
    current: cur?.id ?? '',
    outputs: rt?.view === 'loops' ? outputs(cur) : null,
    walls: rt?.walls ?? [],
    layouts: c.walls,
    alerts: activeAlerts(),
    events: rt?.monitor.recentEvents(60) ?? [],
    armed: rt?.armed ? { key: rt.armed.key, proc: rt.armed.proc, what: cur && rt.armed.proc === cur.id ? describe(rt.armed.req, cur) : '' } : null,
    scanning: rt?.scanning ?? false,
    found: rt?.found ?? []
  };
}

// ---- keys --------------------------------------------------------------------------------------

function procPaging(n: number): { perPage: number; pages: number } {
  const perPage = n > 4 ? 3 : 4;
  return { perPage, pages: Math.max(1, Math.ceil(n / perPage)) };
}

/** The command a key sends for the selected processor now, or null when it has none. */
export function commandFor(ctx: C, index: number): ControlRequest | null {
  const p = current(ctx);
  if (!rt || !p?.reachable) return null;
  const caps = p.controls ?? {};
  const presetSlot = (KEY.PRESET as readonly number[]).indexOf(index);
  if (presetSlot >= 0) {
    const pr = (p.presets ?? [])[rt.presetPage * 3 + presetSlot];
    return caps.preset && pr ? { action: 'preset', value: pr.number } : null;
  }
  if ((index === KEY.DIM || index === KEY.BRIGHT) && caps.brightness) {
    const b = caps.brightness;
    const step = b.unit === '%' ? 5 : 100;
    const now = p.brightness ?? (index === KEY.DIM ? b.max : b.min);
    const next = Math.min(b.max, Math.max(b.min, Math.round(now / step) * step + (index === KEY.DIM ? -step : step)));
    return next === p.brightness ? null : { action: 'brightness', value: next };
  }
  if (index === KEY.FREEZE && caps.freeze) return { action: 'freeze', value: !p.freeze };
  if (index === KEY.BLACKOUT && caps.blackout) return { action: 'blackout', value: !p.blackout };
  return null;
}

function keyFaces(ctx: C): KeySetParams[] {
  const c = cfg(ctx);
  const list = views();
  const cur = current(ctx);
  const faces: KeySetParams[] = [];
  const blank = (index: number): KeySetParams => ({ index });

  // Processors
  const { perPage, pages } = procPaging(list.length);
  const page = Math.min(rt?.procPage ?? 0, pages - 1);
  for (let k = 0; k < 4; k++) {
    if (k === 3 && pages > 1) {
      faces.push({ index: k, label: 'MORE ▶', sublabel: `${page + 1} of ${pages}` });
      continue;
    }
    const p = list[page * perPage + k];
    if (!p) {
      faces.push(blank(k));
      continue;
    }
    const sel = p.id === cur?.id;
    const bg = sel ? ACCENT : p.severity === 'critical' ? CRIT : p.severity === 'warning' ? WARN : undefined;
    faces.push({ index: k, label: short(p.name.toUpperCase(), 10), sublabel: p.reachable ? SEV_TEXT[p.severity] : 'OFFLINE', ...(bg ? { background: bg } : {}), ...(sel ? { color: ON_ACCENT } : {}) });
  }
  const n = activeAlerts().length;
  faces.push({ index: KEY.ALERTS, label: 'ALERTS', sublabel: n ? `${n} active` : 'none', ...(n ? { background: ACCENT, color: ON_ACCENT } : {}) });

  if (!cur) {
    for (let k = 5; k < 15; k++) faces.push(blank(k));
    return faces;
  }
  const allow = c.allowControls;
  const armed = rt?.armed && rt.armed.proc === cur.id ? rt.armed.key : -1;
  const offline = !cur.reachable;
  const cmd = (index: number, label: string, sublabel: string, on = false, onBg = ACCENT, onColor = ON_ACCENT): KeySetParams => {
    if (offline) return { index, label, sublabel: 'offline' };
    if (armed === index) return { index, label, sublabel: 'PRESS AGAIN', background: ARMED, color: '#FFE2B0' };
    return { index, label, sublabel, ...(on ? { background: onBg, color: onColor } : {}) };
  };

  // Presets
  const presets = cur.presets ?? [];
  const pp = Math.min(rt?.presetPage ?? 0, Math.max(0, Math.ceil(presets.length / 3) - 1));
  (KEY.PRESET as readonly number[]).forEach((index, slot) => {
    const pr = presets[pp * 3 + slot];
    if (!pr || !cur.controls?.preset) return faces.push(blank(index));
    faces.push(cmd(index, short(pr.name.toUpperCase(), 8), `PRESET ${pr.number}`, cur.preset?.number === pr.number));
  });

  // Brightness
  const b = cur.controls?.brightness;
  if (b) {
    const step = b.unit === '%' ? '5%' : '100';
    faces.push(cmd(KEY.DIM, `− ${step}`, brightnessText(cur) || 'BRIGHTNESS'));
    faces.push(cmd(KEY.BRIGHT, `+ ${step}`, brightnessText(cur) || 'BRIGHTNESS'));
  } else faces.push(blank(KEY.DIM), blank(KEY.BRIGHT));

  // Freeze
  faces.push(cur.controls?.freeze ? cmd(KEY.FREEZE, 'FREEZE', cur.freeze ? 'ON' : 'OFF', !!cur.freeze, BLUE, '#0B1220') : blank(KEY.FREEZE));
  faces.push(blank(11));
  faces.push(presets.length > 3 && cur.controls?.preset ? { index: KEY.PRESET_PAGE, label: 'PRESETS ▶', sublabel: `${pp + 1} of ${Math.ceil(presets.length / 3)}` } : blank(KEY.PRESET_PAGE));
  faces.push(blank(13));

  // Blackout
  if (cur.controls?.blackout) {
    const f = cmd(KEY.BLACKOUT, 'BLACKOUT', cur.blackout ? 'ON' : short(cur.name.toUpperCase(), 12), !!cur.blackout, RED, '#141414');
    faces.push(f);
  } else faces.push(blank(KEY.BLACKOUT));

  // Without Allow controls the keys show the readings and send nothing.
  if (!allow) {
    for (const f of faces) {
      if (f.index < 5 || f.index === KEY.PRESET_PAGE) continue;
      if (f.label) Object.assign(f, f.index === KEY.BLACKOUT ? { label: 'VIEW ONLY', sublabel: 'see Setup' } : {}, { background: undefined, color: undefined });
    }
  }
  return faces.map((f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)) as KeySetParams);
}

export async function draw(ctx: C, clientId?: string): Promise<void> {
  // Both from the same moment, so the keys never lag what the screen shows.
  const snap = snapshot(ctx);
  if (!clientId) {
    if (rt?.drawTimer) clearTimeout(rt.drawTimer);
    if (rt) rt.drawTimer = null;
    await ctx.keys.setMany(keyFaces(ctx));
  }
  await ctx.ui.send(snap, clientId);
}

/** Polls of several processors land close together: draw once for them. */
function soon(ctx: C): void {
  if (!rt || rt.drawTimer) return;
  rt.drawTimer = setTimeout(() => {
    if (!rt) return;
    rt.drawTimer = null;
    quiet(reportStatus(ctx));
    quiet(draw(ctx));
  }, 120);
}

async function reportStatus(ctx: C): Promise<void> {
  const list = views();
  if (!list.length) return ctx.status('disconnected', 'Add a processor in Setup');
  const up = list.filter((p) => p.reachable).length;
  const sev = overall(list);
  if (up === list.length) return ctx.status('connected', sev === 'ok' ? (up === 1 ? '' : `${up} processors`) : `${activeAlerts().length} alerts`);
  return ctx.status(up ? 'connecting' : 'disconnected', `${up} of ${list.length} processors answering`);
}

// ---- selection: the module's own state ---------------------------------------------------------

async function setView(ctx: C, v: unknown): Promise<void> {
  if (!rt || !VIEWS.includes(v as View)) return;
  rt.view = v as View;
  quiet(ctx.strip.select(rt.view));
  await draw(ctx);
}

async function selectProcessor(ctx: C, id: unknown): Promise<void> {
  if (!rt || typeof id !== 'string' || !rt.monitor.view(id)) return;
  if (id !== ctx.state.value.proc) {
    disarm();
    rt.presetPage = 0;
  }
  await ctx.state.patch({ proc: id });
  await draw(ctx);
}

// ---- setup: the module's own config, reads only ----------------------------------------------

function syncMonitor(ctx: C): void {
  if (!rt) return;
  const c = cfg(ctx);
  rt.monitor.thresholds = c.thresholds;
  rt.monitor.setProcessors(c.processors.map(toDriverConfig));
  refreshWalls(ctx);
  quiet(reportStatus(ctx));
}

async function addProcessor(ctx: C, m: any): Promise<void> {
  if (!rt) return;
  const host = typeof m.host === 'string' ? m.host.trim() : '';
  if (!validAddress(host)) return ctx.notify('That is not an IP address or host name', 'warning');
  const kind: ProcessorKind = KINDS.includes(m.kind) ? m.kind : 'brompton';
  const port = m.port === undefined || m.port === '' || m.port === null ? 0 : Number(m.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return ctx.notify('Port must be 1 to 65535, or empty for the usual one', 'warning');
  const c = cfg(ctx);
  if (c.processors.some((p) => p.host === host && p.kind === kind && p.port === port)) return ctx.notify(`${host} is already in the list`);
  if (c.processors.length >= MAX_PROCESSORS) return ctx.notify(`Up to ${MAX_PROCESSORS} processors`, 'warning');
  const id = randomBytes(4).toString('hex');
  const label = typeof m.label === 'string' ? m.label.trim().slice(0, 40) : '';
  await ctx.setConfig({ ...c, processors: [...c.processors, { id, kind, host, port, label, portCapacity: 0 }] });
  await ctx.log('info', `Added ${kind} processor ${host}${port ? `:${port}` : ''}`);
  syncMonitor(ctx);
  if (!ctx.state.value.proc) await ctx.state.patch({ proc: id });
  await draw(ctx);
}

async function editProcessor(ctx: C, m: any): Promise<void> {
  const c = cfg(ctx);
  const e = c.processors.find((p) => p.id === m.id);
  if (!e) return;
  const next = { ...e };
  if (typeof m.label === 'string') next.label = m.label.trim().slice(0, 40);
  if (m.portCapacity !== undefined) {
    const n = Number(m.portCapacity || 0);
    if (!Number.isInteger(n) || n < 0 || n > 100_000_000) return ctx.notify('Port capacity is a whole number of pixels, or empty to work it out', 'warning');
    next.portCapacity = n;
  }
  await ctx.setConfig({ ...c, processors: c.processors.map((p) => (p.id === e.id ? next : p)) });
  syncMonitor(ctx);
  await draw(ctx);
}

async function removeProcessor(ctx: C, id: unknown): Promise<void> {
  const c = cfg(ctx);
  const e = c.processors.find((p) => p.id === id);
  if (!rt || !e) return;
  const processors = c.processors.filter((p) => p.id !== e.id);
  // A wall driven by the removed processor goes with it; one that used it as the backup keeps its primary.
  await ctx.setConfig({ ...c, processors, walls: cleanWalls(c.walls, new Set(processors.map((p) => p.id))) });
  if (rt.armed?.proc === e.id) disarm();
  await ctx.log('info', `Removed processor ${e.host}`);
  syncMonitor(ctx);
  if (ctx.state.value.proc === e.id) await ctx.state.patch({ proc: cfg(ctx).processors[0]?.id ?? '' });
  await draw(ctx);
}

async function moveProcessor(ctx: C, id: unknown, by: unknown): Promise<void> {
  const c = cfg(ctx);
  const i = c.processors.findIndex((p) => p.id === id);
  const j = i + (by === -1 ? -1 : 1);
  if (i < 0 || j < 0 || j >= c.processors.length) return;
  const list = [...c.processors];
  [list[i], list[j]] = [list[j]!, list[i]!];
  await ctx.setConfig({ ...c, processors: list });
  syncMonitor(ctx);
  await draw(ctx);
}

async function setThresholds(ctx: C, t: unknown): Promise<void> {
  const c = cfg(ctx);
  const given = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(given)) {
    const range = THRESHOLD_RANGES[k as keyof Thresholds];
    if (!range) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < range[0] || v > range[1]) return ctx.notify(`Not saved: that limit must be from ${range[0]} to ${range[1]}`, 'warning');
  }
  const merged = cleanThresholds({ ...c.thresholds, ...given });
  if (merged.tempCritC < merged.tempWarnC || merged.tileTempCritC < merged.tileTempWarnC) return ctx.notify('A critical limit must be at or above its warning limit', 'warning');
  await ctx.setConfig({ ...c, thresholds: merged });
  syncMonitor(ctx);
  await ctx.notify('Alert limits saved. They apply from the next poll.');
  await draw(ctx);
}

async function setWalls(ctx: C, raw: unknown, clientId: string): Promise<void> {
  const c = cfg(ctx);
  let walls: WallLayout[];
  try {
    walls = parseWalls(raw, new Set(c.processors.filter((p) => p.kind === 'brompton').map((p) => p.id)));
  } catch (e) {
    if (!(e instanceof WallError)) throw e;
    // The editor keeps its changes so they can be corrected.
    await ctx.ui.send({ type: 'walls-result', ok: false }, clientId);
    return ctx.notify(`Walls not saved: ${e.message}`, 'warning');
  }
  await ctx.setConfig({ ...c, walls });
  await ctx.log('info', `Wall layouts saved (${walls.length})`);
  await ctx.notify('Wall layouts saved');
  refreshWalls(ctx);
  await draw(ctx);
  await ctx.ui.send({ type: 'walls-result', ok: true }, clientId);
}

/**
 * The XD pairs and chains a Brompton processor's cable loop reports show, for the wall editor to start from, and its
 * failover partner as the backup. Built from the last reading: nothing is asked of the processor.
 */
function suggestWall(m: any) {
  const p = typeof m.primary === 'string' ? rt?.monitor.view(m.primary) : undefined;
  if (!p || p.kind !== 'brompton') return { type: 'wall-suggestion', ref: m.ref, error: 'Choose a Brompton processor first' };
  if (!p.loops.length) return { type: 'wall-suggestion', ref: m.ref, error: `${p.name} reports no cable loops` };
  const existing = Array.isArray(m.groups) ? (m.groups as WallLayout['groups']) : [];
  const groups = wallGroupsFromLoops(p.loops, existing, p.tiles?.associated ?? 0);
  const serial = p.failover?.partnerSerial;
  const partner = serial ? views().find((x) => x.id !== p.id && x.serial === serial) : undefined;
  return { type: 'wall-suggestion', ref: m.ref, groups, backup: partner?.id ?? '' };
}

async function setAllow(ctx: C, on: unknown): Promise<void> {
  await ctx.setConfig({ ...cfg(ctx), allowControls: !!on });
  if (!on) disarm();
  await ctx.log('info', on ? 'Controls allowed' : 'Controls turned off: the module only reads');
  await draw(ctx);
}

/** Test and development hook: comma-separated host:port list to ask instead of scanning the subnets. */
function scanTargets(): { host: string; port: number }[] | null {
  const env = process.env.RCS_LED_SCAN;
  if (!env) return null;
  return env
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [host, port] = s.split(':');
      return { host: host!, port: Number(port) || 0 };
    });
}

/** Asks every address on the unit's /24 subnets the processors' read-only identity questions. */
async function scan(ctx: C, subnet?: unknown): Promise<void> {
  if (!rt || rt.scanning) return;
  const r = rt;
  r.scanning = true;
  await draw(ctx);
  try {
    const found: Found[] = [];
    const targets = scanTargets();
    if (targets) {
      for (const t of targets) {
        const got = await identify(t.host, 800, { brompton: t.port || 80, coex: t.port || 8001 });
        if (got) found.push({ ...got, port: t.port });
      }
    } else {
      const subnets = typeof subnet === 'string' && subnet ? [subnet.replace(/\.$/, '')] : localSubnets();
      if (subnets.some((s) => !isSubnet(s))) {
        await ctx.notify('Give the first three parts of an address, like 10.10.20', 'warning');
        return;
      }
      for (const s of subnets) {
        const hosts = Array.from({ length: 254 }, (_, i) => `${s}.${i + 1}`);
        for (let i = 0; i < hosts.length; i += 64) {
          const batch = await Promise.all(hosts.slice(i, i + 64).map((h) => identify(h, 800)));
          for (const b of batch) if (b) found.push({ ...b, port: 0 });
        }
      }
    }
    if (rt !== r) return;
    r.found = found.slice(0, 64);
    if (!found.length) await ctx.notify('No Tessera or COEX processor answered on this network');
  } catch (e) {
    await ctx.notify(`Scan failed: ${(e as Error).message}`, 'warning');
  } finally {
    if (rt === r) {
      r.scanning = false;
      await draw(ctx);
    }
  }
}

// ---- operator actions: the only things that change a processor ------------------------------

function disarm(): void {
  if (!rt?.armed) return;
  clearTimeout(rt.armed.timer);
  rt.armed = null;
}

async function send(ctx: C, id: string, req: ControlRequest, who: string): Promise<boolean> {
  if (!rt) return false;
  if (!cfg(ctx).allowControls && req.action !== 'resetErrors') {
    await ctx.notify('This module only reads. Turn on Allow controls in Setup to send commands.', 'warning');
    return false;
  }
  try {
    const v = await rt.monitor.control(id, req, who);
    await ctx.log('info', `${v.name}: ${describe(req, v)} (${who})`);
    await ctx.notify(`${v.name}: ${describe(req, v)}`);
    return true;
  } catch (e) {
    await ctx.notify(e instanceof ControlError ? e.message : `Not sent: ${(e as Error).message}`, 'error');
    return false;
  } finally {
    await draw(ctx);
  }
}

/** First press arms a command key; a second press of the same key within CONFIRM_MS sends it. */
async function pressCommand(ctx: C, index: number): Promise<void> {
  if (!rt) return;
  const p = current(ctx);
  const req = commandFor(ctx, index);
  if (!p || !req) return;
  if (!cfg(ctx).allowControls) {
    disarm();
    await ctx.notify('This module only reads. Turn on Allow controls in Setup to send commands.', 'warning');
    return;
  }
  const a = rt.armed;
  if (a && a.key === index && a.proc === p.id && JSON.stringify(a.req) === JSON.stringify(req)) {
    disarm();
    await draw(ctx);
    await send(ctx, p.id, req, 'the panel keys');
    return;
  }
  disarm();
  const r = rt;
  r.armed = {
    key: index,
    proc: p.id,
    req,
    timer: setTimeout(() => {
      if (rt !== r || r.armed?.key !== index) return;
      r.armed = null;
      quiet(draw(ctx));
    }, CONFIRM_MS)
  };
  await draw(ctx); // the key and the screen say "press again"; nothing is sent yet
}

function requestOf(m: any): ControlRequest | null {
  switch (m?.action) {
    case 'brightness':
    case 'preset':
      return Number.isFinite(Number(m.value)) ? { action: m.action, value: Number(m.value) } : null;
    case 'blackout':
    case 'freeze':
      return { action: m.action, value: !!m.value };
    case 'input':
      return typeof m.value === 'string' ? { action: 'input', value: m.value } : null;
    case 'failover':
    case 'reboot':
    case 'resetErrors':
      return { action: m.action };
  }
  return null;
}

export default defineModule<State, Config>({
  async start(ctx) {
    if (rt) rt.monitor.stop();
    const c = cfg(ctx);
    const monitor = new Monitor({ pollIntervalMs: pollMs(), requestTimeoutMs: timeoutMs(), thresholds: c.thresholds ?? DEFAULT_THRESHOLDS, dataDir: ctx.dataDir });
    const r: Runtime = (rt = { monitor, topology: new Topology(), walls: [], view: 'overview', procPage: 0, presetPage: 0, armed: null, scanning: false, found: [], drawTimer: null });
    await ctx.state.init({ proc: '' });
    await ctx.strip.set([
      { id: 'overview', label: 'Overview', icon: 'assets/overview.svg' },
      { id: 'alerts', label: 'Alerts', icon: 'assets/alerts.svg' },
      { id: 'loops', label: 'Loops', icon: 'assets/loops.svg' },
      { id: 'topology', label: 'Topology', icon: 'assets/topology.svg' },
      { id: 'setup', label: 'Setup', icon: 'assets/setup.svg' }
    ]);
    monitor.on('change', () => {
      if (rt !== r) return;
      refreshWalls(ctx);
      soon(ctx);
    });
    monitor.on('event', (e: MonitorEvent) => {
      if (rt !== r || e.source === 'control') return;
      if (e.level === 'warning' || e.level === 'critical') quiet(ctx.log(e.level === 'critical' ? 'error' : 'warning', e.message));
    });
    monitor.setProcessors(c.processors.map(toDriverConfig));
    refreshWalls(ctx);
    monitor.start(); // reads only: nothing is sent on start, whatever the reason
    if (!ctx.state.value.proc && c.processors[0]) await ctx.state.patch({ proc: c.processors[0].id });
    await reportStatus(ctx);
    await draw(ctx);
  },

  stop() {
    if (!rt) return;
    if (rt.drawTimer) clearTimeout(rt.drawTimer);
    disarm();
    rt.monitor.stop();
    rt = null;
  },

  async key(ctx, { index, action }) {
    if (action !== 'down' || !rt) return;
    const list = views();
    if (index < 4) {
      const { perPage, pages } = procPaging(list.length);
      if (index === 3 && pages > 1) {
        rt.procPage = (rt.procPage + 1) % pages;
        return draw(ctx);
      }
      const p = list[Math.min(rt.procPage, pages - 1) * perPage + index];
      if (p) await selectProcessor(ctx, p.id);
      return;
    }
    if (index === KEY.ALERTS) return setView(ctx, 'alerts');
    if (index === KEY.PRESET_PAGE) {
      const n = current(ctx)?.presets?.length ?? 0;
      if (n > 3) {
        disarm();
        rt.presetPage = (rt.presetPage + 1) % Math.ceil(n / 3);
        await draw(ctx);
      }
      return;
    }
    await pressCommand(ctx, index);
  },

  async strip(ctx, id) {
    await setView(ctx, id);
  },

  async client(ctx, { clientId, action }) {
    if (action === 'connect') await draw(ctx, clientId);
  },

  async ui(ctx, { clientId, message: m }) {
    if (!rt || typeof m !== 'object' || m === null) return;
    switch (m.type) {
      case 'hello':
        return draw(ctx, clientId);
      case 'view':
        return setView(ctx, m.view);
      case 'select':
        return selectProcessor(ctx, m.id);
      case 'get-processor': {
        // The web view keeps its own processor, so browsing there never moves the panel.
        const p = typeof m.id === 'string' ? rt.monitor.view(m.id) : undefined;
        return ctx.ui.send({ type: 'processor', id: m.id, outputs: outputs(p), events: p ? rt.monitor.recentEvents(100, p.id) : [] }, clientId);
      }
      case 'control': {
        // From a screen that already asked the operator to confirm (the web view's dialog).
        const req = requestOf(m);
        if (!req || typeof m.id !== 'string') return;
        await send(ctx, m.id, req, m.from === 'web' ? 'the web view' : 'the panel');
        return;
      }
      case 'add':
        return addProcessor(ctx, m);
      case 'edit':
        return editProcessor(ctx, m);
      case 'remove':
        return removeProcessor(ctx, m.id);
      case 'move':
        return moveProcessor(ctx, m.id, m.by);
      case 'thresholds':
        return setThresholds(ctx, m.values);
      case 'allow':
        return setAllow(ctx, m.on);
      case 'walls':
        return setWalls(ctx, m.walls, clientId);
      case 'suggest-wall':
        return ctx.ui.send(suggestWall(m), clientId);
      case 'scan':
        return scan(ctx, m.subnet);
      case 'reconnect':
        rt.monitor.pollAll();
        return;
    }
  }
});
