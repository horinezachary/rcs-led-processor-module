// Turns wall layouts and the processors' live state into what the Topology view draws (ported from LEDScreenControl).
// Brompton walls come from a layout in the module's config, because Tessera reports processor health, failover and
// cable loops but not where tiles are. COEX walls come from the processor's own cabinet map.
// Live state is painted onto that layout: which processor is driving, trunk state, and which chain loops are intact.
import type {
  BoxLayout,
  GroupLayout,
  BoxView,
  ChainView,
  GroupView,
  LinkState,
  PortView,
  ProcessorView,
  Severity,
  TileView,
  TrunkView,
  WallLayout,
  WallProcessorView,
  WallView,
} from './shared.js';
import { wallGroupsFromLoops, worstSeverity } from './shared.js';

const LOOP_FOUND = /^loop-found:\s*([A-Za-z]+\d+)\s*->\s*([A-Za-z]+\d+)/;

export class Topology {
  /** Which loop index each chain was last seen under, per processor, so a lost loop can be pinned to its chain. */
  private loopOf = new Map<string, string>();
  /** The XD pairs and ports last seen in each Brompton processor's loop reports, so a lost loop keeps its chain. */
  private seenGroups = new Map<string, GroupLayout[]>();

  build(layouts: WallLayout[], processors: Map<string, ProcessorView>): WallView[] {
    const walls: WallView[] = [];
    const covered = new Set<string>();
    for (const layout of layouts) {
      const primary = processors.get(layout.primary);
      if (!primary) continue;
      covered.add(layout.primary);
      if (layout.backup) covered.add(layout.backup);
      walls.push(this.layoutWall(layout, primary, layout.backup ? processors.get(layout.backup) : undefined));
    }
    // Every other Brompton processor still gets a wall, drawn from its cable loops, with its failover partner.
    for (const p of processors.values()) {
      if (p.kind !== 'brompton' || covered.has(p.id)) continue;
      const serial = p.failover?.partnerSerial;
      const partner = serial ? [...processors.values()].find((x) => x.kind === 'brompton' && x.id !== p.id && !covered.has(x.id) && x.serial === serial) : undefined;
      const [primary, backup] = partner && p.failover?.role === 'backup' && partner.failover?.role !== 'backup' ? [partner, p] : [p, partner];
      covered.add(primary.id);
      if (backup) covered.add(backup.id);
      walls.push(this.loopsWall(primary, backup));
    }
    for (const p of processors.values()) {
      if (p.topology) walls.push(processorWall(p));
    }
    return walls;
  }

  private loopsWall(primary: ProcessorView, backup: ProcessorView | undefined): WallView {
    const source = primary.loops.length ? primary : backup?.loops.length ? backup : primary;
    const derived = wallGroupsFromLoops(source.loops, [], 0);
    const chains = (g: GroupLayout[]) => g.reduce((n, x) => n + x.chains.filter((c) => c > 0).length, 0);
    const key = primary.id;
    const before = this.seenGroups.get(key);
    // A broken loop can drop out of the report's pairing: keep the larger picture seen before.
    const groups = before && chains(before) > chains(derived) ? before : derived;
    if (groups.length) this.seenGroups.set(key, groups);
    const layout: WallLayout = { id: `loops:${primary.id}`, name: primary.name, primary: primary.id, backup: backup?.id, fromLoops: true, groups };
    const wall = this.layoutWall(layout, primary, backup);
    if (!groups.length) wall.notes.unshift(primary.reachable ? `${source.name} reports no cable loops yet.` : 'Waiting for the processor to answer.');
    else wall.notes.push('Drawn from the cable loops. Add this wall in Setup to show the tiles on each chain.');
    return wall;
  }

  private layoutWall(layout: WallLayout, primary: ProcessorView, backup: ProcessorView | undefined): WallView {
    const backupDriving = !!backup && isBackupDriving(primary, backup);
    const driver = backupDriving ? backup! : primary;
    const notes: string[] = [];

    const trunks: TrunkView[] = [];
    layout.groups.forEach((g, gi) => {
      for (const side of ['left', 'right'] as const) {
        const box = g[side];
        if (!box) continue;
        trunks.push({
          label: box.trunk ? `Trunk ${box.trunk}` : box.name,
          group: gi,
          side,
          fromPrimary: link(primary, !backupDriving),
          fromBackup: backup ? link(backup, backupDriving) : undefined,
        });
      }
    });

    const tilesAllOnline = !!driver.tiles && driver.tiles.online >= driver.tiles.associated;
    if (driver.reachable && driver.tiles && !tilesAllOnline) {
      notes.push(
        `${driver.tiles.associated - driver.tiles.online} tiles offline. Tessera reports the count only, not which chain they are on.`,
      );
    }
    const tileSeverity: Severity = !driver.reachable ? 'unknown' : tilesAllOnline ? 'ok' : 'unknown';
    const configuredTiles = layout.groups.reduce((n, g) => n + g.chains.reduce((a, b) => a + b, 0), 0);
    if (!layout.fromLoops && driver.reachable && driver.tiles && configuredTiles !== driver.tiles.associated) {
      notes.push(`The layout has ${configuredTiles} tiles and ${driver.name} knows ${driver.tiles.associated}. Check the layout.`);
    }

    const groups: GroupView[] = layout.groups.map((g, gi) => ({
      left: boxView(g.left, driver),
      right: g.right ? boxView(g.right, driver) : undefined,
      chains: g.chains
        .map((count, pi) => ({ count, port: pi + 1 }))
        .filter((c) => c.count > 0)
        .map(({ count, port }) => this.layoutChain(layout, gi, g.left, g.right, port, count, driver, tileSeverity)),
    }));

    const chainSev = groups.flatMap((g) => g.chains.map((c) => c.severity));
    const procSev = [primary.severity, ...(backup ? [backup.severity] : [])].filter((s) => s !== 'unknown');
    return {
      id: layout.id,
      name: layout.name,
      source: layout.fromLoops ? 'loops' : 'layout',
      severity: worstSeverity([...procSev, ...chainSev.filter((s) => s !== 'unknown' && s !== 'ok')]),
      primary: wallProcessor(primary, backup ? 'primary' : 'single', !backupDriving),
      backup: backup ? wallProcessor(backup, 'backup', backupDriving) : undefined,
      trunks,
      groups,
      notes,
    };
  }

  private layoutChain(
    layout: WallLayout,
    group: number,
    left: BoxLayout,
    right: BoxLayout | undefined,
    port: number,
    count: number,
    driver: ProcessorView,
    tileSeverity: Severity,
  ): ChainView {
    const a = `${left.trunk ?? left.name}${port}`;
    const b = right ? `${right.trunk ?? right.name}${port}` : undefined;
    const id = `${layout.id}:${group}:${port}`;
    const loop = b ? this.loopState(driver, id, a, b) : 'none';
    const live: LinkState = driver.reachable ? 'ok' : 'unknown';
    const from: PortView = { label: a, state: live };
    const to: PortView | undefined = b
      ? { label: b, state: !driver.reachable ? 'unknown' : loop === 'broken' ? 'lost' : loop === 'ok' ? 'standby' : 'unknown' }
      : undefined;
    const notes: string[] = [];
    if (loop === 'broken') notes.push(`The cable loop from ${a} to ${b} is broken, so this chain has lost its redundant end.`);
    if (loop === 'unknown' && b) notes.push(`${driver.name} does not report a loop for ${a} to ${b}.`);
    // A wall drawn from loops alone does not know how many tiles a chain has.
    const tileCount = layout.fromLoops ? 0 : count;
    const tiles: TileView[] = Array.from({ length: tileCount }, (_, i) => ({ id: `${id}:${i}`, severity: tileSeverity }));
    return {
      id,
      label: b ? `${a} to ${b}` : a,
      tiles,
      tileCount,
      from,
      to,
      loop,
      severity: loop === 'broken' ? 'warning' : driver.reachable ? 'ok' : 'unknown',
      notes,
    };
  }

  /**
   * Tessera lists each chain's loop as "loop-found: A1->B1" when it is cabled and seen. When it breaks the text
   * becomes "no-loop-found: A1->No connection", which no longer names the far end, so the loop's key is remembered
   * to tell which chain broke. Ports that were never looped also read "no-loop-found" and are not called broken.
   */
  private loopState(p: ProcessorView, chainId: string, a: string, b: string): ChainView['loop'] {
    const memKey = `${p.id}|${chainId}`;
    for (const loop of p.loops) {
      const m = LOOP_FOUND.exec(loop.state);
      if (!m) continue;
      const [x, y] = [m[1].toUpperCase(), m[2].toUpperCase()];
      if ((x === a.toUpperCase() && y === b.toUpperCase()) || (x === b.toUpperCase() && y === a.toUpperCase())) {
        this.loopOf.set(memKey, loop.key);
        return 'ok';
      }
    }
    const key = this.loopOf.get(memKey);
    if (key !== undefined) {
      const loop = p.loops.find((l) => l.key === key);
      if (loop && !loop.found) return 'broken';
    }
    return 'unknown';
  }
}

/** The backup drives the wall when either processor says failover is active, or the primary is gone and the backup is not. */
export function isBackupDriving(primary: ProcessorView, backup: ProcessorView): boolean {
  if (primary.failover?.active || backup.failover?.active) return true;
  return !primary.reachable && primary.lastSeen !== undefined && backup.reachable;
}

function link(p: ProcessorView, driving: boolean): LinkState {
  if (!p.reachable) return p.lastSeen === undefined && p.severity === 'unknown' ? 'unknown' : 'lost';
  return driving ? 'ok' : 'standby';
}

function boxView(box: BoxLayout, driver: ProcessorView): BoxView {
  const dev = box.serial ? driver.devices?.find((d) => d.id === box.serial || d.id.includes(box.serial!)) : undefined;
  return {
    name: box.name,
    trunk: box.trunk,
    online: box.serial ? (driver.reachable ? !!dev && dev.online !== false : undefined) : undefined,
    firmware: dev?.firmware,
  };
}

export function wallProcessor(p: ProcessorView, role: WallProcessorView['role'], driving: boolean): WallProcessorView {
  const active = p.inputs.find((i) => i.active);
  const parts: string[] = [];
  if (!p.reachable) parts.push(p.lastError ?? 'Waiting for the first answer');
  else {
    if (active) {
      parts.push(
        active.signal
          ? `${active.label} · ${active.width}×${active.height}${active.rate ? ` · ${Number.isInteger(active.rate) ? active.rate : active.rate.toFixed(2)} Hz` : ''}`
          : `${active.label} · no signal`,
      );
    }
    if (p.genlock) parts.push(`genlock ${p.genlock.source}`);
  }
  return { id: p.id, name: p.name, role, driving, severity: p.severity, reachable: p.reachable, summary: parts.join(' · ') };
}

/** A wall the processor describes itself (COEX), already in view form. */
function processorWall(p: ProcessorView): WallView {
  const t = p.topology!;
  const chainSev = t.groups.flatMap((g) => g.chains.map((c) => c.severity)).filter((s) => s !== 'unknown');
  return {
    id: `proc:${p.id}`,
    name: t.name ?? p.name,
    source: 'processor',
    severity: worstSeverity([p.severity, ...chainSev].filter((s) => s !== 'unknown')),
    primary: wallProcessor(p, 'single', true),
    trunks: [],
    groups: t.groups,
    notes: t.notes ?? [],
  };
}
