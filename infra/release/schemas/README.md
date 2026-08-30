# Release schemas

These schemas define non-secret, canonical inputs. Source templates are not runnable. The root installer accepts only a digest-addressed activation manifest, exactly its referenced shared/application payloads, and a matching root-only approval record. It rejects unknown keys, aliases, mutable images, extra files, unsafe archives, caller environment interpolation, and cross-environment overlays.

The deployment request is staging-only. It is verified again by the root policy controller with the immutable root-owned policy and public key. Production, production mail, public-edge, policy changes, and shared-infrastructure changes always require separate approval records.

Checkpoint and recovery-set records are written atomically and canonically. A completion marker is published last; a partial or mixed set is never restorable.
