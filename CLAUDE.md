# LED Processor Monitor module

A Rack Control Surface module; see README.md. Built like the other module repos (rcs-netgearAV-module,
rcs-unifi-viewer): SDK linked from a rack-control-surface checkout, signed releases on every merge to main.

## Working agreement

Features go on a branch and a pull request. Zac reviews, then merges. Title PRs `feat: ...` for features and
`fix: ...` for fixes; the title decides the version bump.

## Real processors

The processors are live show equipment. Reading from them is fine. **Ask Zac before sending any control command
to a real processor** (brightness, preset, input, blackout, freeze, failover, reboot, any Tessera `?set=` or COEX
PUT/POST). Develop against the simulators (`src/sim`, `npm run sim`).

The processor is the source of truth: config and state hold only the module's own settings; start, restore and
reconnect only read; commands go out only on a confirmed operator action with Allow controls on.
