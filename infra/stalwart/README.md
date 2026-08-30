# Stalwart template boundary

This directory contains only non-secret, transactional-only configuration.
Prompt 04 validates TOML syntax and listener/network policy. It does not start
internet mail, create mailboxes, generate DKIM keys, or install credentials.

The pinned Stalwart image does not expose a documented side-effect-free command
that validates a complete bootstrap configuration without opening stores or
listeners. Prompt 06 must therefore validate the sealed configuration in an
isolated, no-egress Compose project with disposable RocksDB paths, no production
credentials, no host ports, and a fixed private administration address. The
test must prove the internal submission listener, private management listener,
health override, relay denial, quotas, and API/worker/Caddy network denials
before any Netcup Mail-block, firewall, PTR, DNS, or external-delivery change.
