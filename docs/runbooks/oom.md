# OOM and memory pressure

Alert on sustained RAM above 70%, treat sustained 75%+ as urgent, and treat normal-load swap or any OOM as a capacity failure.

1. Record `free`, pressure stall information, cgroup/container limits, Docker stats, kernel OOM events, restarts, PostgreSQL/cache state, queues, and the triggering operation.
2. Stop/defer backup, restore, media, or maintenance bursts through the fixed wrappers; do not remove memory limits.
3. Keep Sharp concurrency 1, cache at the bounded configured value, 10 MiB encoded input, 25 million decoded pixels, one page/frame, 30-second timeout, and no video/animated processing.
4. Reduce workload or tune PostgreSQL/Valkey inside their caps only with evidence. Do not endlessly retry an OOM-killed job.
5. If normal combined load cannot stay below the thresholds with headroom, resize or migrate before adding services/replicas.

Verify staging and production health/isolation after recovery and record the capacity decision.

