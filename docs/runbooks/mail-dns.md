# Production mail and DNS gate

Stalwart remains defined but inactive/private until Prompt 06. Keep the Netcup Mail block enabled through Prompt 05. Do not publish SMTP, change PTR/MX/SPF/DKIM/DMARC, install production mail secrets, or send external mail during Prompt 04/05.

Before a separately signed `production-mail` transition:

1. Record written Netcup transactional-only policy clarification where needed, abuse owner, assigned-IP reputation, IPv4 identity, and rollback path.
2. Privately validate Stalwart configuration, fixed admin listener, TLS/SNI for `mail.<domain>`, queue limits, low transactional quotas, signed/idempotent feedback, suppression behavior, and no marketing/bulk/end-user mailbox capability.
3. Review the complete Netcup and Docker-aware firewall. Open TCP 25 only at the mail gate; operational IMAPS remains `127.0.0.1:1993` for a tunnel. Keep management private.
4. Set and verify forward A, PTR, MX, SPF, DKIM, DMARC, bounce/feedback, TLS, and DNS-only mail records. Delay IPv6 mail until forward/PTR/firewall/TLS/delivery all pass.
5. Remove the Mail block only with explicit approval; prove inbound and outbound TCP 25 separately.
6. Activate the exact reviewed external structural variant, send only controlled transactional tests, monitor queues/bounces/deferrals/reputation, and retain a next-sequence private-mail rollback.

Application A/AAAA and proxy choice are separate from mail DNS. OAuth uses exact environment-specific HTTPS callbacks and no wildcards/shared secrets.

