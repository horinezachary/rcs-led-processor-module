# LED Processor Monitor

A [Rack Control Surface](https://github.horinetech.com/rcs-releases/) module that watches the LED
processors on a show network: Brompton Tessera (SX40, S8 and the rest), NovaStar COEX (MX40 Pro,
CX40 Pro) and NovaStar VX Pro. It reads each processor every 5 seconds, turns what it reads into
alerts, and keeps a processor's controls on the Stream Deck. The drivers, health rules and simulators
come from [LEDScreenControl](https://github.com/horinezachary/LEDScreenControl).

- **Overview**: a card per processor: alerts, active input and signal, genlock, hottest temperature,
  fans, tiles online, redundancy, brightness, firmware and uptime, with BLACKOUT, FROZEN and the
  loaded preset as badges. Tap a card (or its key) to select it.
- **Alerts**: every active alert, worst first, and the event log since the module started.
- **Loops**: for a Tessera, every cable loop and whether it is found, plus tile counts and tile
  firmware. For COEX, each output port with its cabinets (coloured by health and temperature) and its
  load against the port's capacity, plus the hottest tiles.
- **Topology**: each wall as a diagram, as in LEDScreenControl. The processor that normally drives
  the wall on top, its backup underneath, the distribution boxes as columns and each tile chain as a
  row between a pair of boxes: solid where signal is driven, dashed where a path is standby, red where
  it is lost. A broken Tessera cable loop is pinned to its chain. Every Brompton processor (with its
  failover partner) is drawn from its cable loops with no setup; a layout (below) adds the tiles on
  each chain. COEX walls come from the processor's own cabinet map, with port loads. Tap a processor, box or chain
  for its details; the header tabs choose the wall on this screen only.
- **Setup**: processors by address (or found by a network scan), Allow controls, and the alert limits.

The web view has the same pages with more detail: every temperature and fan, a temperature chart,
the controls (brightness slider, presets, input, blackout, freeze, failover, reboot, COEX error count
reset), the event log with filters, distribution boxes and the processor list with names, order and
COEX port capacity.

### Brompton wall layouts

Without a layout, a Brompton wall is drawn from its cable loops. Tessera does not report how many
tiles are on each chain, so to show tiles, a wall is described once under **Brompton walls** in the web view's Setup: the processor pair, and for
each pair of XD boxes the trunk letters and the tiles on each port's chain (a chain runs from port N
on the left box to port N on the right box). **Fill in from** starts from the XD pairs and cabled ports
in the processor's last cable loop report, without asking the processor anything; Tessera does not say
how many tiles are on a chain, so check the even share it suggests. Layouts are the module's own config
and go into named saves. A wall goes away with its primary processor; removing its backup keeps it as
a single-processor wall.

## Stream Deck

| Key | Does |
| --- | --- |
| 1-4 | Processors (key 4 pages when there are more than 4). Press to select. Colour: selected, warning or critical |
| 5 | Alerts: how many are active. Press for the Alerts view |
| 6-8 | Presets of the selected processor; key 13 pages through more |
| 9 / 10 | Brightness down / up (100 nits on Tessera, 5% on NovaStar) |
| 11 | Freeze on / off |
| 15 | Blackout on / off |

On a larger deck (an XL, 8×4, or a Stream Deck + XL, 9×4) the top row holds more processors with Alerts on
its last key, presets fill the rest of the second row and every row down to the bottom, Brightness down / up
sit at the end of the second row, and the bottom row starts with Freeze and ends with Blackout. This needs
controller 0.21.0 or later; older controllers show the 15-key layout.

Every command key needs a **second press within 3 seconds**: the first press only arms it (the key reads
PRESS AGAIN and the screen names the command). Any other key disarms it.

## The processors are the source of truth

Everything shown is read from the processors and kept only in memory: nothing about a processor is
saved. State holds which processor the panel shows; config holds the processor list, the alert limits
and the Allow controls switch, so named saves carry exactly those. Starting, restoring a save, resuming
after a power cut and reconnecting only read. The module sends a command only when someone presses a
command key twice or confirms one in the web view, and only with **Allow controls** on in Setup (off by
default). After a command it reads the processor again and shows what it then reports.

The processors' IP control APIs take no login, so the module keeps no secrets. COEX receiving card
error counts only grow; **Reset error counts** remembers the counts in the module's data folder so only
new errors raise an alert. It sends nothing to the processor and works with Allow controls off.

## What it reads and writes

| Processor | Reads (every 5 s) | Commands |
| --- | --- | --- |
| Tessera, `http://<ip>/api/` (port 80) | `GET /api/` | `GET /api/<path>?set=<value>`: brightness, preset, input, blackout, freeze, request failover, reboot |
| COEX, `http://<ip>:8001/api/v1/` | `device/hw`, `device/monitor/info`, `screen`, `device/input/sources`, `screen/displayparams`, `screen/output/display/state`, `preset`, `device/backup`, `screen/output` | `PUT screen/brightness`, `PUT screen/output/displaymode`, `POST preset/current/update`, `PUT screen/layer/input` |
| VX Pro | the COEX API on port 8001 if it answers, else the mode ID over TCP 15200 | brightness and presets 1 to 10 over TCP 15200 |
| Other device | a TCP connection to its port (80 unless set) | none |

**Scan network** asks every address on the unit's /24 networks (or one you give) `GET /api/` on port 80
and `GET /api/v1/device/hw` on port 8001, nothing else.

Caveats carried over from LEDScreenControl: COEX units and status codes are assumed (°C, V, brightness
0 to 1, status 0 normal), COEX refuses requests while NovaStar VMP has the processor open (the card
says so), and nothing has been sent to a real VX Pro. **Commands have only been tried against the
simulators.** Ask before pointing a development build with Allow controls on at real show equipment.

Not ported yet: Brompton wall layouts (the Topology page), processor syslog, email alerts and the
long history charts.

## Develop

Node.js 22 or later, and a checkout of the main `rack-control-surface` repo, which holds the SDK
until it is published to npm.

```sh
# next to this folder: git clone …/rack-control-surface && cd rack-control-surface && npm install && npm run build
npm install            # links the SDK from ../rack-control-surface when it is there
npm run link-sdk -- C:\src\rack-control-surface    # or point at a checkout somewhere else (or set RCS_REPO)
npm test               # driver, rule and module tests against the simulators and the SDK's fake controller
npm run sim            # two Tessera SX40s on 127.0.0.1:8081/8082, a COEX MX40 Pro on :8011, a VX Pro on tcp :15200
RCS_LED_SCAN=127.0.0.1:8081,127.0.0.1:8082,127.0.0.1:8011 npm run dev
```

In the simulator (http://127.0.0.1:5173/sim) open the module's Setup and press Scan network, or add
the simulated processors by address and port in the web view (http://127.0.0.1:5174). Switch faults on
with, for example, `curl 'http://127.0.0.1:8081/sim/scenario?set=fan-failure'` (the scenarios are listed
at the top of each file in `src/sim`). `RCS_LED_POLL_MS` polls faster during development.

## Releasing

Every merge to `master` (the default branch) is a release (`.github/workflows/release.yml`), versioned from the PR title:
`feat:` is a minor bump, `!:` or `BREAKING CHANGE` a major one, anything else a patch; `[skip release]`
skips it. The workflow tests, stamps the version into `module.json`, packs, signs and publishes
`led-monitor-<version>.zip` and its `.sig` as a GitHub release here, where units find it through the
module index in [horinezachary/rcs-releases](https://github.com/horinezachary/rcs-releases).

It needs two Actions secrets:

- `RCS_SIGNING_KEY`: the module's private signing key, made with
  `node node_modules/@rcs/module-sdk/dist/pack-cli.js keygen`. Its public key,
  `ed25519:xfH6Ue+QmIlDYuc1SbCvcdXV9aGr/5xdtkEy6fv6cmg=`, is this module's entry in `index.json` in
  rcs-releases.
- `RCS_SOURCE_TOKEN`: a fine-grained token with Contents read-only on `rack-control-surface`, so the
  workflows can link the SDK from it. CI uses the tag in `package.json` `rcs.sdkRef`.

## Layout

| Path | What |
| --- | --- |
| `src/index.ts` | The module backend: views, keys, confirmations, config and the messages its UIs send |
| `src/monitor.ts` | Polls each processor, keeps readings, alerts and events in memory, sends confirmed commands |
| `src/drivers/` | Tessera, COEX, VX Pro and plain device drivers (from LEDScreenControl) |
| `src/rules.ts`, `src/thresholds.ts` | Health rules and alert limits |
| `src/scan.ts` | The read-only network scan |
| `src/topology.ts`, `src/walls.ts` | Wall diagrams from layouts and readings, and the wall layout checks |
| `src/shared.ts` | The processor reading shapes every driver produces |
| `src/sim/`, `src/sim-cli.ts` | Simulated processors with switchable faults |
| `ui/index.html` | The panel UI: Overview, Alerts, Loops, Topology, Setup |
| `web/index.html` | The web view's pages: Processors, Alerts, Loops & tiles, Topology, Setup |
| `test/fixtures/` | Read-only captures from a real Tessera SX40 and a real CX40 Pro |
| `scripts/link-sdk.mjs` | Links `@rcs/*` from a main repo checkout |
