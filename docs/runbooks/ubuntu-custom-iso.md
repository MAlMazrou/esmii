# Ubuntu 26.04 custom ISO preparation

Use this only if the official Ubuntu 26.04 LTS amd64 image is absent from Netcup SCP. Do not upload, mount, boot, reimage, or delete anything during Prompt 04.

## Local preparation

1. Obtain the official Ubuntu 26.04 LTS server amd64 ISO and its release checksum/signature from Ubuntu.
2. Verify the signing key through an independent Ubuntu channel, verify the signed checksum file, then verify the ISO SHA-256. Record the URL, ISO filename, size, release date, signature result, checksum, and verifier version.
3. Do not modify or remaster the ISO. Store it in a bounded local path and treat it as immutable.
4. Record the expected target: the reviewed Netcup server ID, x86-64/KVM, 4 dedicated cores, 8 GB RAM, 256 GB NVMe, assigned IPv4, routed IPv6 `/64`, and confirmed-empty status.

## Later SCP procedure — explicit approval required

1. Verify SCP console and rescue access before changing media.
2. Verify the exact server identity and that no data must be preserved.
3. Upload/select the verified ISO using Netcup's custom-media workflow.
4. Boot the ISO through SCP console and install Ubuntu with UEFI, GPT, the entire disk for the OS, OpenSSH, UTC, `en_US.UTF-8`, and the named bootstrap operator. Do not add application secrets.
5. Unmount the ISO, boot the installed disk, and record `uname -m`, `/etc/os-release`, disk, routes, assigned addresses, time sync, and SSH host-key fingerprints.
6. Stop if any identity, disk, route, architecture, checksum, console, or recovery detail differs.

Reimaging is destructive and belongs to Prompt 05 only after exact target review and approval.

