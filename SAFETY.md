# Safety policy

> [README](README.md) · [Architecture](ARCHITECTURE.md)

Everything below is enforced by [`docs/src/domain/safety.js`](docs/src/domain/safety.js) and
covered by [`test/safety.test.mjs`](test/safety.test.mjs). The constraint set is a versioned
**safety envelope** (`SAFETY_ENVELOPE_VERSION`); every audit-trail entry is stamped with the
version that produced it, and changing a rule requires bumping it.

Verdicts are one of three:

| Verdict | Meaning |
|---|---|
| `PASS` | the frame goes to the bus unchanged |
| `CLAMP` | the frame is rewritten to a safe value (checksum recomputed) and then sent |
| `REJECT` | the frame is dropped and never reaches the bus |

Crucially, the verdict depends on the **vehicle state at the moment of inspection** — speed and
gear. Above 5 km/h the driving policy applies.

## The rules

### Always

- **CAN ID allowlist** — any ID outside `0x3BF` / `0x3C0..0x3C6` is `REJECT`ed unconditionally.
  The compiler already cannot produce one; this is the defense-in-depth double check.
- **Message integrity** — rolling counter + checksum mismatch → `REJECT`. A frame that was
  tampered with or corrupted after compilation does not get executed.
- **Flash-frequency cap** — 5 Hz ceiling for `flash` and `pulse` effects → `CLAMP`.
  This is a photosensitivity guard, not an aesthetic preference.
- **Watchdog** — a single program is clamped to 30 s. `endState: off` forces an all-off tail so
  a program cannot leave the cabin latched in an arbitrary state.

### While driving (> 5 km/h)

- **Flash-frequency cap tightens to 3 Hz** → `CLAMP`.
- **Red flashing is banned on every zone** → `REJECT`. Red flashing inside a cabin reads as a
  warning lamp; a lighting program must not be able to imitate one.
- **Forward-field zones** (currently the dashboard) — brightness is capped at 40% (glare guard,
  `CLAMP`) and `flash` is downgraded to `breathe` (distraction guard, `CLAMP`).
- **Master brightness** is capped at 60% → `CLAMP`.

### Always available

- **E-STOP** — a trusted, *unreviewed* path that turns every zone off immediately. It is the one
  thing in the system that does not go through the supervisor, because a guaranteed route back to
  a safe state must not be blockable by the thing it is protecting against.

## Why the rules re-run

Reviewing a program once at generation time leaves two holes, both closed by
[`runtime-monitor.js`](docs/src/application/runtime-monitor.js):

1. A frame approved while parked may be **transmitted** seconds later, while driving. The TX gate
   re-inspects at transmission time.
2. A frame that already reached the ECU stays **latched** — the cabin keeps glowing red long after
   the review finished. When `VEHICLE_STATE` changes, the monitor re-inspects the latched state and
   clamps it, or switches the zone off.

An intervention increments a counter, publishes a `RUNTIME_INTERVENTION` domain event, and lands
in the audit trail with the phase (`tx-gate` or `reassure`), the verdict and the reason.

## What this does *not* claim

- It is not a certified safety case, and the envelope is not derived from a hazard analysis of a
  real vehicle. The rules are plausible, testable stand-ins.
- It targets a **comfort-domain lighting node**. Extending the same structure to a safety-relevant
  actuator would require far more than a longer rule list.
- The AI is never trusted, but the *compiler*, the *supervisor* and the *monitor* are. Bugs there
  are real bugs — which is why they are the parts under unit test.
