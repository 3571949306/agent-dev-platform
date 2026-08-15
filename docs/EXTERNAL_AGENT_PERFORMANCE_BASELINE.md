# External Agent P4 Performance Baseline

This is a deterministic release baseline, not a provider-latency promise. Measurements use local fixtures on the release workstation and include process startup/cleanup where applicable.

| Workload | Current observation | Release interpretation |
| --- | --- | --- |
| P4 production smoke | 229/229 in about 30 seconds | Closure plus all transport families and security counters complete within the bounded harness |
| P4 soak | Detection 50, identity 100, seven 20-cycle races/lifecycles, late events 1000 in about 8 seconds | No growing process/server/lock/session/temp residue |
| P4 final closure | 13/13 in about 18 seconds | False-completion, late-quiescence/quarantine, consent, response and sanitizer contracts remain bounded |
| P4 GUI verification cases | 33/33; full E2E 192/192 in about 4.4 minutes | Safe/Real controls and separate protocol/response/project truth remain interactive |
| Real verification without opt-in | Immediate deterministic skip | Zero provider/model calls |

Provider network time, authentication prompts, and model inference are intentionally excluded because no real external model task is authorized in the automated baseline. Regression gates care about bounded timeouts, quiescence, unique terminal state, and zero residue rather than claiming a universal wall-clock SLA.
