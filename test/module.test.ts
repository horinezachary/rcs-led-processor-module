// The module against simulated processors and the SDK's fake controller: the source-of-truth rules
// (start, restore and reconnect only read; commands only on a confirmed operator action), the keys,
// and the web view's messages.
import { startTestModule, type TestModule } from '@rcs/module-sdk/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import mod, { KEY, type Config, type State } from '../src/index.js';
import { CoexSimulator } from '../src/sim/coex.js';
import { TesseraSimulator } from '../src/sim/tessera.js';
import { DEFAULT_THRESHOLDS } from '../src/thresholds.js';

let sim: TestModule<State, Config> | null = null;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(() => {
  process.env.RCS_LED_POLL_MS = '200';
});

afterEach(async () => {
  await sim?.close();
  sim = null;
  while (cleanups.length) await cleanups.pop()!();
  delete process.env.RCS_LED_SCAN;
});

async function until(check: () => boolean, ms = 5000, what = ''): Promise<void> {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) throw new Error(`timed out ${what}: ${JSON.stringify(last()?.processors?.map((p: any) => [p.name, p.reachable, p.lastError]))} ${sim?.errors.map(String)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const last = () => (sim ? [...sim.uiMessages].reverse().find((m) => m.message?.type === 'snapshot')?.message : null);

async function tessera(name = 'Stage Main') {
  const t = new TesseraSimulator({ name, serial: '900001', role: 'primary', partnerName: 'Stage Backup', partnerSerial: '900002', seed: 3 });
  const port = await t.listen();
  cleanups.push(() => t.close());
  return { t, port };
}

async function coex() {
  const c = new CoexSimulator({ name: 'Side IMAG', serial: '7', seed: 4 });
  const port = await c.listen();
  cleanups.push(() => c.close());
  return { c, port };
}

const entry = (id: string, kind: 'brompton' | 'coex', port: number) => ({ id, kind, host: '127.0.0.1', port, label: '', portCapacity: 0 });

async function start(processors: Config['processors'], extra: { allow?: boolean; state?: State; reason?: 'boot' | 'restore' | 'user' } = {}) {
  const config: Config = { processors, thresholds: DEFAULT_THRESHOLDS, walls: [], allowControls: extra.allow ?? false };
  sim = await startTestModule(mod, { config, state: extra.state, reason: extra.reason });
  await sim.settle();
  await until(() => last()?.processors?.length === processors.length && last().processors.every((p: any) => p.reachable), 5000, 'for the processors');
  await sim.settle();
  return sim;
}

describe('the processors are the source of truth', () => {
  it.each(['boot', 'restore', 'user'] as const)('only reads on a %s start, whatever the save or state says', async (reason) => {
    const { t, port } = await tessera();
    const { c, port: cport } = await coex();
    await start([entry('00000001', 'brompton', port), entry('00000002', 'coex', cport)], { allow: true, reason, state: { proc: '00000002' } });
    await new Promise((r) => setTimeout(r, 500)); // a few polls
    expect(t.writes).toEqual([]);
    expect(c.writes).toEqual([]);
    const s = last();
    expect(s.processors[0]).toMatchObject({ name: 'Stage Main', model: 'Tessera SX40', reachable: true, severity: 'ok', blackout: false });
    expect(s.processors[1]).toMatchObject({ name: 'Side IMAG', brightnessText: '80%' });
    expect(s.current).toBe('00000002');
    // Nothing read from a processor goes into state or config.
    expect(Object.keys(sim!.state)).toEqual(['proc']);
    expect(JSON.stringify(sim!.config)).not.toMatch(/Stage Main|Tessera|brightness/);
  });

  it('reconnect only reads', async () => {
    const { t, port } = await tessera();
    await start([entry('00000001', 'brompton', port)], { allow: true });
    await sim!.sendUi({ type: 'reconnect' });
    await new Promise((r) => setTimeout(r, 300));
    expect(t.writes).toEqual([]);
  });

  it('shows the last readings marked unreachable when a processor stops answering, and recovers', async () => {
    const { t, port } = await tessera();
    await start([entry('00000001', 'brompton', port)]);
    await t.close();
    await until(() => last().processors[0].reachable === false, 3000, 'for the drop');
    expect(last().processors[0].model).toBe('Tessera SX40');
    expect(sim!.status?.connection).toBe('disconnected');
  });
});

describe('alerts', () => {
  it('raises and clears alerts, and logs them as events', async () => {
    const { t, port } = await tessera();
    await start([entry('00000001', 'brompton', port)]);
    t.scenario = 'fan-failure';
    await until(() => last().alerts.some((a: any) => a.rule === 'fan'), 3000, 'for the fan alert');
    expect(last().severity).toBe('critical');
    expect(sim!.keys[KEY.ALERTS]).toMatchObject({ label: 'ALERTS', sublabel: '1 active' });
    expect(sim!.keys[0]).toMatchObject({ sublabel: 'CRITICAL' });
    t.scenario = 'normal';
    await until(() => !last().alerts.length, 3000, 'for the alert to clear');
    expect(last().events.map((e: any) => e.message).join('\n')).toMatch(/cleared, case 2 fan has stopped/i);
    expect(sim!.logs.some((l) => l.level === 'error' && /fan has stopped/.test(l.text))).toBe(true);
  });

  it('takes alert limits from Setup', async () => {
    const { port } = await tessera();
    await start([entry('00000001', 'brompton', port)]);
    await sim!.sendUi({ type: 'thresholds', values: { tempWarnC: 30, tempCritC: 200 } });
    expect(sim!.notifications.at(-1)).toMatchObject({ level: 'warning', text: expect.stringMatching(/from 20 to 130/) });
    expect(sim!.config.thresholds.tempWarnC).toBe(70);
    await sim!.sendUi({ type: 'thresholds', values: { tempWarnC: 30 } });
    expect(sim!.config.thresholds.tempWarnC).toBe(30);
    await until(() => last().alerts.some((a: any) => a.rule === 'temperature'), 3000, 'for a temperature alert');
  });
});

describe('controls', () => {
  it('sends nothing while Allow controls is off', async () => {
    const { t, port } = await tessera();
    await start([entry('00000001', 'brompton', port)]);
    expect(sim!.keys[KEY.BLACKOUT]).toMatchObject({ label: 'VIEW ONLY' });
    await sim!.press(KEY.BLACKOUT);
    await sim!.press(KEY.BLACKOUT);
    await sim!.sendUi({ type: 'control', id: '00000001', action: 'blackout', value: true, from: 'web' });
    expect(t.writes).toEqual([]);
    expect(sim!.notifications.some((n) => /only reads/.test(n.text))).toBe(true);
  });

  it('needs a second press of the same key within 3 s, then shows what the processor says', async () => {
    const { t, port } = await tessera();
    await start([entry('00000001', 'brompton', port)], { allow: true });
    expect(sim!.keys[KEY.BLACKOUT]).toMatchObject({ label: 'BLACKOUT' });
    await sim!.press(KEY.BLACKOUT);
    expect(t.writes).toEqual([]);
    expect(sim!.keys[KEY.BLACKOUT]).toMatchObject({ sublabel: 'PRESS AGAIN' });
    expect(last().armed).toMatchObject({ key: KEY.BLACKOUT, what: 'blackout on' });
    // A different key disarms it instead of sending.
    await sim!.press(KEY.FREEZE);
    await sim!.press(KEY.BLACKOUT);
    expect(t.writes).toEqual([]);
    await sim!.press(KEY.BLACKOUT);
    await until(() => t.writes.length > 0, 2000, 'for the write');
    expect(t.writes).toEqual([['override/blackout/enabled', 'true']]);
    await until(() => last().processors[0].blackout === true, 2000, 'for the new reading');
    expect(sim!.keys[KEY.BLACKOUT]).toMatchObject({ sublabel: 'ON' });
    expect(last().events[0]).toMatchObject({ source: 'control', message: expect.stringMatching(/blackout on, from the panel keys/) });
  });

  it('lets an armed key lapse after 3 s', async () => {
    const { t, port } = await tessera();
    await start([entry('00000001', 'brompton', port)], { allow: true });
    await sim!.press(KEY.FREEZE);
    await new Promise((r) => setTimeout(r, 3200));
    await sim!.press(KEY.FREEZE);
    expect(t.writes).toEqual([]);
    expect(sim!.keys[KEY.FREEZE]).toMatchObject({ sublabel: 'PRESS AGAIN' });
  }, 10000);

  it('loads presets and steps brightness from the keys', async () => {
    const { t, port } = await tessera();
    await start([entry('00000001', 'brompton', port)], { allow: true });
    expect(sim!.keys[KEY.PRESET[1]]).toMatchObject({ label: 'REHEARSA', sublabel: 'PRESET 2' });
    await sim!.press(KEY.PRESET[1]);
    await sim!.press(KEY.PRESET[1]);
    await until(() => t.writes.length === 1);
    expect(t.writes[0]).toEqual(['presets/active/number', '2']);
    await sim!.press(KEY.BRIGHT);
    await sim!.press(KEY.BRIGHT);
    await until(() => t.writes.length === 2);
    expect(t.writes[1]).toEqual(['output/global-colour/brightness', '1600']);
  });

  it('sends a web view command that was confirmed there, and checks it', async () => {
    const { t, port } = await tessera();
    await start([entry('00000001', 'brompton', port)], { allow: true });
    await sim!.sendUi({ type: 'control', id: '00000001', action: 'input', value: 'sdi:2', from: 'web' });
    await until(() => t.writes.length === 2);
    await sim!.settle();
    await until(() => sim!.notifications.some((n) => /input switched to SDI 2/.test(n.text)));
    expect(t.writes).toEqual([['input/active/source/port-type', 'sdi'], ['input/active/source/port-number', '2']]);
    await sim!.sendUi({ type: 'control', id: '00000001', action: 'input', value: 'hdmi:9', from: 'web' });
    expect(t.writes).toHaveLength(2);
    expect(sim!.notifications.at(-1)?.text).toMatch(/not on this processor/);
  });

  it('resets COEX error counts without sending anything, even read-only', async () => {
    const { c, port } = await coex();
    c.cardErrors = 3;
    await start([entry('00000002', 'coex', port)]);
    await until(() => last().alerts.some((a: any) => a.key === 'tile-errors'), 3000, 'for the error alert');
    await sim!.sendUi({ type: 'control', id: '00000002', action: 'resetErrors', from: 'web' });
    await until(() => !last().alerts.some((a: any) => a.key === 'tile-errors'), 3000, 'for the reset');
    expect(c.writes).toEqual([]);
  });
});

describe('setup', () => {
  it('adds, renames, orders and removes processors in config only', async () => {
    const { t, port } = await tessera();
    const { c, port: cport } = await coex();
    await start([entry('00000001', 'brompton', port)]);
    await sim!.sendUi({ type: 'add', kind: 'coex', host: '127.0.0.1', port: cport });
    await until(() => last().processors.length === 2 && last().processors[1].reachable, 3000, 'for the new processor');
    const id = sim!.config.processors[1]!.id;
    expect(sim!.config.processors[1]).toMatchObject({ kind: 'coex', host: '127.0.0.1', port: cport, label: '', portCapacity: 0 });
    await sim!.sendUi({ type: 'add', kind: 'coex', host: '127.0.0.1', port: cport });
    expect(sim!.config.processors).toHaveLength(2);
    await sim!.sendUi({ type: 'add', kind: 'brompton', host: 'not an address!' });
    expect(sim!.notifications.at(-1)?.level).toBe('warning');
    await sim!.sendUi({ type: 'edit', id, label: 'IMAG' });
    await until(() => last().processors.find((p: any) => p.id === id)?.name === 'IMAG');
    await sim!.sendUi({ type: 'move', id, by: -1 });
    expect(sim!.config.processors[0]!.id).toBe(id);
    await sim!.sendUi({ type: 'remove', id });
    expect(sim!.config.processors.map((p) => p.id)).toEqual(['00000001']);
    expect(t.writes).toEqual([]);
    expect(c.writes).toEqual([]);
  });

  it('finds processors with read-only identity questions', async () => {
    const { t, port } = await tessera();
    const { c, port: cport } = await coex();
    process.env.RCS_LED_SCAN = `127.0.0.1:${port},127.0.0.1:${cport}`;
    sim = await startTestModule(mod, { config: { processors: [], thresholds: DEFAULT_THRESHOLDS, walls: [], allowControls: false } });
    await sim.settle();
    expect(sim.status?.connection).toBe('disconnected');
    await sim.sendUi({ type: 'scan' });
    await until(() => last()?.found?.length === 2 && !last().scanning, 5000, 'for the scan');
    expect(last().found).toEqual([
      expect.objectContaining({ kind: 'brompton', name: 'Stage Main', port }),
      expect.objectContaining({ kind: 'coex', name: 'Side IMAG', port: cport })
    ]);
    expect(t.writes).toEqual([]);
    expect(c.writes).toEqual([]);
  });

  it('turns Allow controls on and off', async () => {
    const { port } = await tessera();
    await start([entry('00000001', 'brompton', port)]);
    await sim!.sendUi({ type: 'allow', on: true });
    expect(sim!.config.allowControls).toBe(true);
    expect(sim!.keys[KEY.BLACKOUT]).toMatchObject({ label: 'BLACKOUT' });
    await sim!.press(KEY.BLACKOUT);
    await sim!.sendUi({ type: 'allow', on: false });
    expect(last().armed).toBeNull();
  });
});

describe('panel navigation', () => {
  it('selects processors from the keys and pages through more than four', async () => {
    const list = [];
    for (let i = 0; i < 5; i++) {
      const { port } = await tessera(`Wall ${i + 1}`);
      list.push(entry(`0000000${i + 1}`, 'brompton', port));
    }
    await start(list);
    expect(sim!.keys[3]).toMatchObject({ label: 'MORE ▶', sublabel: '1 of 2' });
    await sim!.press(1);
    expect(sim!.state.proc).toBe('00000002');
    await sim!.press(3);
    expect(sim!.keys[0]).toMatchObject({ label: 'WALL 4' });
    await sim!.press(1);
    expect(sim!.state.proc).toBe('00000005');
    await sim!.press(KEY.ALERTS);
    expect(last().view).toBe('alerts');
    await sim!.tapStrip('loops');
    expect(last().outputs).toMatchObject({ id: '00000005', loops: expect.any(Array) });
  });
});
