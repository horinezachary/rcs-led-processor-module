// Walls: the Brompton layout in config, live state painted onto it (ported from LEDScreenControl's topology tests),
// COEX walls from the processor's own map, and the module's Topology messages. Building a wall only reads.
import { startTestModule, type TestModule } from '@rcs/module-sdk/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import mod, { type Config, type State } from '../src/index.js';
import { CoexSimulator } from '../src/sim/coex.js';
import { demoWall, TesseraSimulator, type Scenario } from '../src/sim/tessera.js';
import { DEFAULT_THRESHOLDS } from '../src/thresholds.js';
import { Topology } from '../src/topology.js';
import { cleanWalls, parseWalls, WallError } from '../src/walls.js';
import { monitorFor } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
let sim: TestModule<State, Config> | null = null;
beforeAll(() => {
  process.env.RCS_LED_POLL_MS = '200';
});
afterEach(async () => {
  await sim?.close();
  sim = null;
  while (cleanups.length) await cleanups.pop()!();
});

const MAIN = 'a0000001';
const BACKUP = 'a0000002';

async function sims() {
  const main = new TesseraSimulator({ name: 'Main', serial: '1', role: 'primary', partnerName: 'Backup', partnerSerial: '2', seed: 1 });
  const backup = new TesseraSimulator({ name: 'Backup', serial: '2', role: 'backup', partnerName: 'Main', partnerSerial: '1', seed: 2 });
  const ports = [await main.listen(), await backup.listen()];
  cleanups.push(() => main.close(), () => backup.close());
  return { main, backup, ports };
}

async function pair() {
  const { main, backup, ports } = await sims();
  const monitor = monitorFor(
    [
      { id: MAIN, kind: 'brompton', host: '127.0.0.1', port: ports[0] },
      { id: BACKUP, kind: 'brompton', host: '127.0.0.1', port: ports[1] },
    ],
    { requestTimeoutMs: 500 },
  );
  const topology = new Topology();
  const layout = demoWall(MAIN, BACKUP);
  const pollBoth = async () => {
    await monitor.pollOnce(MAIN);
    await monitor.pollOnce(BACKUP);
    return topology.build([layout], new Map(monitor.views().map((v) => [v.id, v])))[0]!;
  };
  const set = (s: Scenario) => {
    main.scenario = s;
    backup.scenario = s;
  };
  return { main, backup, pollBoth, set };
}

describe('wall layouts in config', () => {
  const ids = new Set(['m0000001', 'b0000001']);
  it('needs known processors and tile counts per port', () => {
    const group = { left: { name: 'XD A', trunk: 'a' }, chains: [4, 0, 4] };
    const [w] = parseWalls([{ name: 'Wall', primary: 'm0000001', groups: [group] }], ids);
    expect(w).toMatchObject({ id: 'wall', groups: [{ left: { trunk: 'A', ports: 10 }, chains: [4, 0, 4] }] });
    expect(() => parseWalls([{ primary: 'x', groups: [] }], ids)).toThrow(WallError);
    expect(() => parseWalls([{ primary: 'm0000001', groups: [{ left: {}, chains: [] }] }], ids)).toThrow(/name/);
    expect(() => parseWalls([{ primary: 'm0000001', groups: [{ left: { name: 'X', ports: 2 }, chains: [1, 1, 1] }] }], ids)).toThrow(/3 ports/);
    expect(() => parseWalls([{ primary: 'm0000001', backup: 'm0000001', groups: [] }], ids)).toThrow(/different/);
    // Empty ports past the end of a smaller box are dropped rather than refused.
    expect(parseWalls([{ primary: 'm0000001', groups: [{ left: { name: 'X', ports: 2 }, chains: [1, 1, 0, 0] }] }], ids)[0]!.groups[0]!.chains).toEqual([1, 1]);
  });

  it('drops walls whose primary is gone and keeps those that only lost their backup', () => {
    const walls = [
      { id: 'one', name: 'One', primary: 'm0000001', backup: 'gone0001', groups: [] },
      { id: 'two', name: 'Two', primary: 'gone0001', groups: [] },
      'junk',
    ];
    expect(cleanWalls(walls, ids)).toEqual([{ id: 'one', name: 'One', primary: 'm0000001', groups: [] }]);
  });
});

describe('topology', () => {
  it('draws the wall with the primary driving and every loop intact', async () => {
    const { pollBoth } = await pair();
    const wall = await pollBoth();
    expect(wall).toMatchObject({ name: 'Main stage wall (simulated)', severity: 'ok', primary: { driving: true }, backup: { driving: false } });
    expect(wall.trunks.map((t) => [t.label, t.fromPrimary, t.fromBackup])).toEqual([
      ['Trunk A', 'ok', 'standby'],
      ['Trunk B', 'ok', 'standby'],
      ['Trunk C', 'ok', 'standby'],
      ['Trunk D', 'ok', 'standby'],
    ]);
    const chains = wall.groups.flatMap((g) => g.chains);
    expect(chains).toHaveLength(20);
    expect(chains.every((c) => c.loop === 'ok' && c.to?.state === 'standby')).toBe(true);
    expect(chains[3]).toMatchObject({ label: 'A4 to B4', tileCount: 8 });
    expect(wall.groups[0]!.left).toMatchObject({ name: 'XD A', online: true, firmware: '3.5.2' });
    expect(wall.notes).toEqual([]);
  });

  it('pins a broken loop to its chain even though Tessera no longer names the ports', async () => {
    const { pollBoth, set } = await pair();
    await pollBoth();
    set('loop-broken');
    const wall = await pollBoth();
    const a4 = wall.groups[0]!.chains[3]!;
    expect(a4).toMatchObject({ loop: 'broken', severity: 'warning', to: { label: 'B4', state: 'lost' } });
    expect(wall.severity).toBe('warning');
    expect(wall.groups[0]!.chains[2]!.loop).toBe('ok');
  });

  it('shows the backup driving after failover and when the primary goes away', async () => {
    const { pollBoth, set, main } = await pair();
    await pollBoth();
    set('failover');
    let wall = await pollBoth();
    expect(wall).toMatchObject({ primary: { driving: false }, backup: { driving: true } });
    expect(wall.trunks[0]).toMatchObject({ fromPrimary: 'standby', fromBackup: 'ok' });

    set('normal');
    await main.close();
    wall = await pollBoth();
    expect(wall.backup?.driving).toBe(true);
    expect(wall.trunks[0]).toMatchObject({ fromPrimary: 'lost', fromBackup: 'ok' });
  });

  it('says when tiles are offline but cannot place them', async () => {
    const { pollBoth, set } = await pair();
    set('tiles-offline');
    const wall = await pollBoth();
    expect(wall.notes[0]).toMatch(/13 tiles offline/);
    expect(wall.groups[0]!.chains[0]!.tiles[0]!.severity).toBe('unknown');
  });
});

// ---- the module ----

const last = () => (sim ? [...sim.uiMessages].reverse().find((m) => m.message?.type === 'snapshot')?.message : null);
const lastOf = (type: string) => (sim ? [...sim.uiMessages].reverse().find((m) => m.message?.type === type)?.message : null);
async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) throw new Error(`timed out ${what} ${sim?.errors.map(String)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function startModule(walls: unknown[] = []) {
  const { main, backup, ports } = await sims();
  const c = new CoexSimulator({ name: 'Side IMAG', serial: '7', seed: 4 });
  const cport = await c.listen();
  cleanups.push(() => c.close());
  const entry = (id: string, kind: 'brompton' | 'coex', port: number) => ({ id, kind, host: '127.0.0.1', port, label: '', portCapacity: 0 });
  const config = {
    processors: [entry(MAIN, 'brompton', ports[0]!), entry(BACKUP, 'brompton', ports[1]!), entry('a0000003', 'coex', cport)],
    thresholds: DEFAULT_THRESHOLDS,
    walls,
    allowControls: true,
  } as Config;
  sim = await startTestModule(mod, { config, reason: 'boot' });
  await until(() => last()?.processors?.every((p: any) => p.reachable) && last().walls.length === walls.length + 1, 'for the walls');
  return { main, backup, coex: c };
}

describe('the Topology view', () => {
  it('draws the saved Brompton wall and the COEX wall, and only reads', async () => {
    const { main, backup, coex } = await startModule([demoWall(MAIN, BACKUP)]);
    await sim!.tapStrip('topology');
    await until(() => last()?.view === 'topology', 'for the view');
    const s = last();
    expect(s.walls.map((w: any) => [w.name, w.source, w.severity])).toEqual([
      ['Main stage wall (simulated)', 'layout', 'ok'],
      ['Side IMAG screen', 'processor', 'ok'],
    ]);
    expect(s.walls[1].groups[0].chains[0].from.load.percent).toBeGreaterThan(0);
    expect(s.layouts).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 400));
    expect([main.writes, backup.writes, coex.writes]).toEqual([[], [], []]);
  });

  it('saves wall layouts from the web view, refusing ones that do not add up', async () => {
    await startModule();
    const wall = { name: 'Upstage', primary: MAIN, backup: BACKUP, groups: [{ left: { name: 'XD A', trunk: 'A' }, right: { name: 'XD B', trunk: 'B' }, chains: [8, 8] }] };
    await sim!.sendUi({ type: 'walls', walls: [{ ...wall, primary: 'a0000003' }] });
    await sim!.settle();
    expect(sim!.notifications.at(-1)?.text).toMatch(/Walls not saved: .*primary/);
    expect(sim!.config.walls).toEqual([]);

    await sim!.sendUi({ type: 'walls', walls: [wall] });
    await sim!.settle();
    expect(sim!.config.walls).toEqual([{ id: 'upstage', name: 'Upstage', primary: MAIN, backup: BACKUP, groups: [{ left: { name: 'XD A', trunk: 'A', ports: 10 }, right: { name: 'XD B', trunk: 'B', ports: 10 }, chains: [8, 8] }] }]);
    await until(() => last()?.walls[0]?.name === 'Upstage', 'for the new wall');
    expect(last().walls[0].groups[0].chains.map((c: any) => c.label)).toEqual(['A1 to B1', 'A2 to B2']);
    // Nothing read from the processors is saved with it.
    expect(JSON.stringify(sim!.config)).not.toMatch(/driving|standby|loop-found/);

    // Removing the backup keeps the wall on its primary; removing the primary removes the wall.
    await sim!.sendUi({ type: 'remove', id: BACKUP });
    await sim!.settle();
    expect(sim!.config.walls[0]).not.toHaveProperty('backup');
    await sim!.sendUi({ type: 'remove', id: MAIN });
    await sim!.settle();
    expect(sim!.config.walls).toEqual([]);
  });

  it('fills a wall in from the cable loops the processor last reported, without asking it anything', async () => {
    const { main } = await startModule();
    const writes = main.writes.length;
    await sim!.sendUi({ type: 'suggest-wall', ref: 0, primary: MAIN, groups: [] });
    await until(() => !!lastOf('wall-suggestion'), 'for the suggestion');
    const got = lastOf('wall-suggestion');
    expect(got.backup).toBe(BACKUP);
    expect(got.groups.map((g: any) => [g.left.trunk, g.right?.trunk, g.chains.filter((n: number) => n > 0).length])).toEqual([
      ['A', 'B', 10],
      ['C', 'D', 10],
    ]);
    expect(main.writes.length).toBe(writes);
    await sim!.sendUi({ type: 'suggest-wall', ref: 1, primary: 'a0000003', groups: [] });
    await until(() => lastOf('wall-suggestion')?.ref === 1, 'for the refusal');
    expect(lastOf('wall-suggestion').error).toMatch(/Brompton/);
  });
});
