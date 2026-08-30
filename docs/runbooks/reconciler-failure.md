# Reconciler failure

The unprivileged reconciler is outbound-only and has no listener. A poll/download/rejection failure must leave the active release unchanged.

1. Check the timer/service result, fixed external alert, network/DNS/TLS to approved GitHub/GHCR/checkpoint endpoints, clock, disk, and the root-owned recovery inhibit.
2. Preserve the rejected canonical request, signature/provenance evidence, policy digest, epoch/sequence, predecessor, and reason without logging credentials.
3. Do not bypass signature/provenance, edit a signed manifest, change the immutable policy, open inbound SSH, run arbitrary Compose, or manually increment the sequence.
4. If the inhibit exists, follow interrupted-operation recovery. If lock contention repeats, identify the authorized operation and wait for its bounded outcome.
5. Revoke the staging policy to stop automation if compromise or repeated malformed requests are suspected.
6. Retry only the same immutable request when the failure was transport-only and its predecessor/epoch/sequence still match. Otherwise issue a new approved next-sequence record.

Production and shared-infrastructure changes can never be recovered by the automatic staging policy.

