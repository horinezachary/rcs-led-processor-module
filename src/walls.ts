// Brompton wall layouts: the module's own description of how a wall is cabled, kept in config. Tessera reports
// processor health, failover and cable loops but not where tiles are, so each wall is described once by hand (or
// filled in from the processor's cable loop reports and corrected): the processor pair, and for each pair of XD boxes
// the tiles on each port's chain. Ported from LEDScreenControl's config parsing.
import type { BoxLayout, GroupLayout, WallLayout } from './shared.js';

export const MAX_WALLS = 8;
export const MAX_GROUPS = 8;
export const MAX_PORTS = 32;
export const MAX_TILES_PER_CHAIN = 500;

export class WallError extends Error {}

/** Checks walls given by the operator and returns them cleaned, or throws a WallError that says what is wrong. */
export function parseWalls(raw: unknown, processorIds: Set<string>): WallLayout[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new WallError('Walls must be a list.');
  if (raw.length > MAX_WALLS) throw new WallError(`Up to ${MAX_WALLS} walls.`);
  const ids = new Set<string>();
  return raw.map((w, i) => {
    if (typeof w !== 'object' || w === null) throw new WallError(`Wall ${i + 1} is not a wall.`);
    const o = w as Record<string, unknown>;
    const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 40) : `Wall ${i + 1}`;
    const where = `"${name}"`;
    let id = typeof o.id === 'string' && /^[a-z0-9-]{1,40}$/.test(o.id) ? o.id : slug(name) || `wall-${i + 1}`;
    if (ids.has(id)) id = `${id}-${i + 1}`;
    ids.add(id);
    if (typeof o.primary !== 'string' || !processorIds.has(o.primary)) throw new WallError(`${where} needs a primary processor from the list.`);
    const backup = o.backup === undefined || o.backup === null || o.backup === '' ? undefined : o.backup;
    if (backup !== undefined && (typeof backup !== 'string' || !processorIds.has(backup))) throw new WallError(`${where}: the backup must be a processor from the list.`);
    if (backup === o.primary) throw new WallError(`${where}: the backup must be a different processor from the primary.`);
    if (!Array.isArray(o.groups)) throw new WallError(`${where} needs a list of box pairs.`);
    if (o.groups.length > MAX_GROUPS) throw new WallError(`${where}: up to ${MAX_GROUPS} box pairs.`);
    const groups = o.groups.map((g, j) => parseGroup(g, `${where}, box pair ${j + 1}`));
    return { id, name, primary: o.primary, ...(backup ? { backup: backup as string } : {}), groups };
  });
}

/** For config read at start or from a save: keeps every wall that is still valid and drops the rest. */
export function cleanWalls(raw: unknown, processorIds: Set<string>): WallLayout[] {
  if (!Array.isArray(raw)) return [];
  const out: WallLayout[] = [];
  for (const w of raw.slice(0, MAX_WALLS)) {
    try {
      // A wall whose backup was removed keeps working as a single-processor wall.
      const o = w && typeof w === 'object' ? { ...(w as Record<string, unknown>) } : w;
      if (o && typeof o === 'object' && typeof o.backup === 'string' && !processorIds.has(o.backup)) delete o.backup;
      const [clean] = parseWalls([o], processorIds);
      if (clean && !out.some((x) => x.id === clean.id)) out.push(clean);
    } catch {
      // skipped: its primary is gone or it was edited into something unreadable
    }
  }
  return out;
}

function parseGroup(raw: unknown, where: string): GroupLayout {
  if (typeof raw !== 'object' || raw === null) throw new WallError(`${where} is not a box pair.`);
  const o = raw as Record<string, unknown>;
  const left = parseBox(o.left, `${where}, left box`);
  const right = o.right === undefined || o.right === null ? undefined : parseBox(o.right, `${where}, right box`);
  if (!Array.isArray(o.chains) || !o.chains.every((n) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= MAX_TILES_PER_CHAIN)) {
    throw new WallError(`${where}: tiles on each port must be whole numbers from 0 to ${MAX_TILES_PER_CHAIN}.`);
  }
  const ports = Math.min(left.ports ?? 10, right?.ports ?? Infinity);
  // Trailing empty ports beyond the box are dropped; tiles on a port the box does not have are a mistake.
  const chains = [...(o.chains as number[])];
  while (chains.length > ports && chains[chains.length - 1] === 0) chains.pop();
  if (chains.length > ports) throw new WallError(`${where} lists tiles on ${chains.length} ports but the box has ${ports}.`);
  return { left, ...(right ? { right } : {}), chains };
}

function parseBox(raw: unknown, where: string): BoxLayout {
  if (typeof raw !== 'object' || raw === null) throw new WallError(`${where} needs a name.`);
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== 'string' || !o.name.trim()) throw new WallError(`${where} needs a name.`);
  const ports = o.ports === undefined || o.ports === null ? 10 : o.ports;
  if (!Number.isInteger(ports) || (ports as number) < 1 || (ports as number) > MAX_PORTS) throw new WallError(`${where}: ports must be 1 to ${MAX_PORTS}.`);
  const trunk = typeof o.trunk === 'string' && o.trunk.trim() ? o.trunk.trim().toUpperCase() : undefined;
  if (trunk !== undefined && !/^[A-Z]{1,2}$/.test(trunk)) throw new WallError(`${where}: the trunk is one or two letters, like A.`);
  const serial = typeof o.serial === 'string' && o.serial.trim() ? o.serial.trim().slice(0, 64) : undefined;
  return { name: o.name.trim().slice(0, 30), ...(trunk ? { trunk } : {}), ports: ports as number, ...(serial ? { serial } : {}) };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}
