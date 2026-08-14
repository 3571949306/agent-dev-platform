# External Agent P4 Performance Baseline

This is a deterministic release baseline, not a provider-latency promise. Measurements use local fixtures on the release workstation and include process startup/cleanup where applicable.

| Workload | Current observation | Release interpretation |
| --- | --- | --- |
| P4 production smoke | 216/216 in about 20 seconds | All transport families and security counters complete within the bounded harness |
| P4 soak | Detection 50, identity 100, seven 20-cycle races/lifecycles, late events 1000 in about 8 seconds | No growing process/server/lock/session/temp residue |
| P4 GUI verification cases | 21/21 in about 9 seconds | Safe verification and truth rendering remain interactive |
| Real verification without opt-in | Immediate deterministic skip | Zero provider/model calls |

Provider network time, authentication prompts, and model inference are intentionally excluded because no real external model task is authorized in the automated baseline. Regression gates care about bounded timeouts, quiescence, unique terminal state, and zero residue rather than claiming a universal wall-clock SLA.
