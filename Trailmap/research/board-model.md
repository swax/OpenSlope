# Board Model — absorbed

This file was the digestible "what to build" distillation of the board model
while the spec did not exist. The whole behavioral model it carried has been
absorbed: the conclusions live in the spec's runtime chapters, the derivations
stay in `elf-map.md`, and the trusted disc-side data in
[`extracted-data.md`](extracted-data.md).

Where each former section went:

| Former section | Spec home | Derivation |
|---|---|---|
| State machine | spec:300-two-machines, spec:300-control-states, spec:300-motion-states | elf-map "State machine and RTTI" |
| Ground update / heading calibration | spec:330-yaw, spec:330-yaw-vals, spec:330-lean | elf-map "Ground steering heading rate" |
| Visible board bank | spec:330-bank | elf-map "Board visual bank / roll basis" |
| Surface coefficients | spec:310-table, spec:310-values | elf-map "Surface physics table" |
| Speed carry / contact correction | spec:320-no-blanket, spec:360-cap, spec:360-cruise | elf-map "Surface physics table" |
| Jump / ramp takeoff | spec:340-charge, spec:340-magnitude, spec:340-blend | elf-map "Jump / Antic charge status" |
| Landing / alignment | spec:340-prealign, spec:340-landing-bands, spec:340-landing-gate | elf-map "Landing and bump leads" |
| Air gravity / control | spec:340-air, spec:340-air-vals, spec:340-air-control | elf-map "Air control leads" |
| Out-of-bounds reset | spec:300-recovery, spec:140-reset-vs-recover, spec:390-reset-path, spec:250-accumulation | elf-map "Out-of-bounds reset / wipeout recovery" |
| Snow springiness / sink | spec:320-overview, spec:320-spring, spec:320-damping | elf-map "Snow springiness…" |
| Ride height / pitch | spec:320-renderpos, spec:320-net, spec:320-bank-dip | elf-map "Board ride height…" |
| Prop collision responses | spec:370-slide, spec:370-bounce, spec:370-impulse | elf-map "Landing and bump leads" |
| Input mapping | — (implementation choice, not game behavior) | `extracted-data.md` "Selected control-map findings" |
