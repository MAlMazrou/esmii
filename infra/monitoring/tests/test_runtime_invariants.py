from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


def read(path: str) -> str:
    return (REPOSITORY_ROOT / path).read_text(encoding="utf-8")


class RuntimeInvariantTests(unittest.TestCase):
    def test_payload_rollback_import_does_not_write_into_the_sealed_tree(self):
        with tempfile.TemporaryDirectory() as temporary:
            payload_monitoring = Path(temporary) / "infra" / "monitoring"
            payload_monitoring.mkdir(parents=True)
            for filename in ("rollback_monitoring_runtime.py", "render_monitoring.py"):
                shutil.copy2(
                    REPOSITORY_ROOT / "infra" / "monitoring" / filename,
                    payload_monitoring,
                )

            environment = os.environ.copy()
            environment.pop("PYTHONDONTWRITEBYTECODE", None)
            environment.pop("PYTHONPYCACHEPREFIX", None)

            result = subprocess.run(
                (
                    sys.executable,
                    str(payload_monitoring / "rollback_monitoring_runtime.py"),
                    "--help",
                ),
                check=False,
                capture_output=True,
                env=environment,
                text=True,
                timeout=10,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((payload_monitoring / "__pycache__").exists())

    def test_monitoring_host_payload_bootstrap_and_command_contract_are_closed(self):
        bootstrap = read("infra/monitoring/materialize-monitoring-payload.sh")
        runbook = read("docs/runbooks/monitoring-dashboard.md")
        self.assertIn("/usr/bin/sha256sum --binary", bootstrap)
        self.assertLess(bootstrap.index("/usr/bin/sha256sum --binary"), bootstrap.index("exec /usr/bin/python3"))
        self.assertIn("ESMII_MONITORING_BOOTSTRAP_SHA256", runbook)
        self.assertIn("ESMII_MONITORING_VERIFIER_SHA256", runbook)
        self.assertGreaterEqual(runbook.count("/usr/bin/sha256sum --check --strict"), 3)
        self.assertNotIn("tar --extract", bootstrap)
        self.assertIn("EXPECTED_VERIFIER_DIGEST", bootstrap)
        self.assertIn("/var/lib/esmii/monitoring/host-payloads/<64_HEX>", runbook)
        self.assertIn('"${ESMII_MONITORING_PAYLOAD_ROOT}"/infra/monitoring/install-host-collectors.sh', runbook)
        self.assertIn('"${ESMII_MONITORING_PAYLOAD_ROOT}"/infra/monitoring/install-pull-wrapper-integration.sh', runbook)
        self.assertNotIn("sudo infra/monitoring/install-host-collectors.sh", runbook)
        self.assertNotIn("sudo infra/monitoring/install-pull-wrapper-integration.sh", runbook)

        for source_path, first_mutation in (
            ("infra/monitoring/install-host-collectors.sh", "install -d -o root"),
            ("infra/monitoring/install-pull-wrapper-integration.sh", "install -d -o root"),
            ("infra/monitoring/rollback-host-collectors.sh", "install -d -o root"),
        ):
            source = read(source_path)
            self.assertLess(source.index("verify-materialized"), source.index(first_mutation))

    def test_compose_has_exact_caps_retention_and_no_public_monitoring_ports(self):
        staging = read("infra/compose.monitoring.staging.yaml")
        production = read("infra/compose.monitoring.production.yaml")
        for compose in (staging, production):
            self.assertNotRegex(compose, r"(?m)^\s*ports:\s*$")
            self.assertNotIn("published:", compose)
            self.assertNotIn("network_mode: host", compose)
            self.assertNotIn("docker.sock", compose)
            self.assertEqual(compose.count("mem_limit: 192m"), 1)
            self.assertEqual(compose.count("mem_limit: 256m"), 1)
            self.assertIn("--storage.tsdb.retention.time=7d", compose)
            self.assertIn("--storage.tsdb.retention.size=1GB", compose)
            self.assertIn("--query.timeout=10s", compose)
            self.assertNotIn("--web.enable-otlp-receiver", compose)
            self.assertNotIn("--web.enable-remote-write-receiver", compose)
            self.assertNotIn("--web.enable-admin-api", compose)
            self.assertNotIn("--web.enable-lifecycle", compose)
            self.assertIn('user: "10003:10003"', compose)
            self.assertNotIn("cadvisor", compose.lower())
        self.assertIn("DASHBOARD_PEER_ORIGIN: https://dashboard.esmii.app", staging)
        self.assertIn("DASHBOARD_PEER_ORIGIN: https://staging-dashboard.esmii.app", production)
        self.assertIn("file: /etc/esmii/monitoring/staging/dashboard-auth-secret", staging)
        self.assertIn("file: /etc/esmii/monitoring/production/dashboard-auth-secret", production)
        self.assertNotIn("/srv/myapp/monitoring", staging + production)
        self.assertNotIn("/etc/myapp/secrets/monitoring", staging + production)

    def test_root_only_host_secret_is_handed_to_uid_10003_without_direct_mount(self):
        for environment in ("staging", "production"):
            compose = read(f"infra/compose.monitoring.{environment}.yaml")
            init_start = compose.index(f"  {environment}-dashboard-secret-init:")
            dashboard_start = compose.index(f"  {environment}-dashboard:")
            init = compose[init_start:dashboard_start]
            dashboard = compose[dashboard_start:]
            self.assertIn('user: "0:10003"', init)
            self.assertIn("network_mode: none", init)
            self.assertIn("cap_drop:\n      - ALL", init)
            self.assertIn("result.gid!==10003", init)
            self.assertIn("(result.mode&0o777)!==0o440", init)
            self.assertIn(
                f"{environment}-dashboard-secrets:/run/dashboard-secrets",
                init,
            )
            self.assertNotIn(f"source: {environment}_dashboard_auth_secret", dashboard)
            self.assertIn(f"{environment}-dashboard-secrets:/run/secrets:ro", dashboard)
            self.assertIn("condition: service_completed_successfully", dashboard)
            self.assertIn(
                f"name: esmii-monitoring-{environment}-dashboard-secret",
                dashboard,
            )

    def test_host_runtime_entrypoints_have_one_fixed_filesystem_target(self):
        renderer = read("infra/monitoring/render_monitoring.py")
        rollback = read("infra/monitoring/rollback_monitoring_runtime.py")
        installer = read("infra/monitoring/install-monitoring-runtime.sh")
        self.assertIn('LIVE_RUNTIME_ROOT = Path("/srv/myapp/staging-runtime")', renderer)
        self.assertIn("validate_live_runtime_root()", renderer)
        self.assertNotIn('add_argument("--runtime-root"', renderer)
        self.assertNotIn('add_argument("--runtime-root"', rollback)
        self.assertNotIn("--runtime-root", installer)
        self.assertIn("--purge-secret-handoff", rollback)

    def test_runtime_manager_and_active_pulls_share_one_gated_compose_state(self):
        manager = read("infra/monitoring/manage-monitoring-runtime.sh")
        integration_installer = read(
            "infra/monitoring/install-pull-wrapper-integration.sh"
        )
        helper = read("infra/monitoring/monitoring_overlay_state.py")
        renderer = read("infra/monitoring/render_monitoring.py")
        rollback = read("infra/monitoring/rollback_monitoring_runtime.py")
        for source in (
            manager,
            integration_installer,
            renderer,
            read("infra/staging-pull/esmii-staging-pull"),
            read("infra/production-pull/esmii-production-pull"),
        ):
            self.assertIn("/run/lock/esmii/host-pull.lock", source)
        self.assertIn("with host_operation_lock():", rollback)
        self.assertIn("--project-name esmii", manager)
        self.assertIn("private-enabled", manager)
        self.assertIn("edge-enabled", manager)
        self.assertIn('if not private_marker.exists():\n            continue', helper)
        self.assertIn("edge_marker.exists() and not private_marker.exists()", helper)
        self.assertIn("MONITORING_COMPOSE_ARGUMENTS", read("infra/staging-pull/esmii-staging-pull"))
        self.assertIn("MONITORING_COMPOSE_ARGUMENTS", read("infra/production-pull/esmii-production-pull"))
        self.assertNotIn("COMPOSE_FILE", manager.split("unset", 1)[0])
        self.assertIn("without starting or stopping a service", integration_installer)

    def test_public_edge_is_a_separate_explicit_overlay(self):
        staging = read("infra/compose.monitoring.staging.yaml")
        production = read("infra/compose.monitoring.production.yaml")
        staging_edge = read("infra/compose.monitoring.staging.edge.yaml")
        production_edge = read("infra/compose.monitoring.production.edge.yaml")
        self.assertNotIn("caddy:", staging)
        self.assertNotIn("staging-dashboard.caddy", staging)
        self.assertNotIn("caddy:", production)
        self.assertNotIn("production-dashboard.caddy", production)
        self.assertIn("staging-dashboard.caddy", staging_edge)
        self.assertNotIn("production-dashboard.caddy", staging_edge)
        self.assertIn("production-dashboard.caddy", production_edge)
        self.assertNotIn("staging-dashboard.caddy", production_edge)
        for edge in (staging_edge, production_edge):
            self.assertNotRegex(edge, r"(?m)^\s*ports:\s*$")
            self.assertNotIn("published:", edge)

    def test_private_networks_are_fixed_and_environment_isolated(self):
        staging = read("infra/compose.monitoring.staging.yaml")
        production = read("infra/compose.monitoring.production.yaml")
        for subnet in ("172.30.40.0/29", "172.30.40.8/29"):
            self.assertIn(f"subnet: {subnet}", staging)
        for subnet in ("172.30.41.0/29", "172.30.41.8/29"):
            self.assertIn(f"subnet: {subnet}", production)
        self.assertEqual(staging.count("internal: true"), 2)
        self.assertEqual(production.count("internal: true"), 2)
        self.assertNotIn("production-monitoring", staging)
        self.assertNotIn("staging-monitoring", production)
        self.assertNotIn("/var/lib/esmii/monitoring/production", staging)
        self.assertNotIn("/var/lib/esmii/monitoring/staging", production)

    def test_host_firewall_allows_fixed_project_same_bridge_monitoring_traffic(self):
        firewall = read("infra/ansible/roles/firewall/files/esmii-docker-firewall.sh")
        staging_pull = read("infra/staging-pull/esmii-staging-pull")
        production_pull = read("infra/production-pull/esmii-production-pull")
        staging = read("infra/compose.monitoring.staging.yaml")
        production = read("infra/compose.monitoring.production.yaml")
        self.assertIn("--project-name esmii", staging_pull)
        self.assertIn("--project-name esmii", production_pull)
        self.assertIn(
            "--filter 'label=com.docker.compose.project=esmii'",
            firewall,
        )
        self.assertNotIn("project=esmii-host", firewall)
        self.assertNotIn("name=^esmii_", firewall)
        self.assertIn('-i "$bridge" -o "$bridge" -j RETURN', firewall)
        for network in (
            "staging-monitoring-edge",
            "staging-monitoring-data",
            "production-monitoring-edge",
            "production-monitoring-data",
        ):
            self.assertIn(f"  {network}:", staging + production)

    def test_node_exporter_has_one_loopback_listener_and_two_private_proxies(self):
        exporter = read("infra/systemd/esmii-node-exporter.service")
        listen_flags = re.findall(r"--web\.listen-address=([^\s\\]+)", exporter)
        self.assertEqual(listen_flags, ["127.0.0.1:9100"])
        self.assertNotIn("0.0.0.0", exporter)
        self.assertNotIn("--collector.systemd", exporter)
        self.assertNotIn("Requires=docker.service", exporter)
        self.assertNotIn("After=docker.service", exporter)
        self.assertIn(
            "--collector.textfile.directory=/run/esmii-node-exporter-textfiles",
            exporter,
        )
        self.assertIn(
            "BindReadOnlyPaths=/var/lib/esmii/monitoring/shared/textfiles:/run/esmii-node-exporter-textfiles",
            exporter,
        )
        self.assertNotIn(
            "--collector.textfile.directory=/var/lib/esmii/monitoring/shared/textfiles",
            exporter,
        )
        self.assertIn("RestrictAddressFamilies=AF_INET AF_NETLINK AF_UNIX", exporter)

        for environment, source, peer_source in (
            ("staging", "172.30.40.11/32", "172.30.41.11/32"),
            ("production", "172.30.41.11/32", "172.30.40.11/32"),
        ):
            proxy = read(
                f"infra/systemd/esmii-node-exporter-{environment}-proxy.service"
            )
            socket = read(
                f"infra/systemd/esmii-node-exporter-{environment}-proxy.socket"
            )
            self.assertIn("systemd-socket-proxyd 127.0.0.1:9100", proxy)
            self.assertIn("IPAddressDeny=any", proxy)
            self.assertIn(f"IPAddressAllow={source}", proxy)
            self.assertNotIn(f"IPAddressAllow={peer_source}", proxy)
            self.assertNotIn("Sockets=", proxy)
            self.assertIn(
                f"Service=esmii-node-exporter-{environment}-proxy.service",
                socket,
            )
        self.assertIn(
            "ListenStream=172.30.40.9:9100",
            read("infra/systemd/esmii-node-exporter-staging-proxy.socket"),
        )
        self.assertIn(
            "ListenStream=172.30.41.9:9100",
            read("infra/systemd/esmii-node-exporter-production-proxy.socket"),
        )

    def test_exporter_firewall_is_source_and_destination_restricted(self):
        installer = read("infra/monitoring/install-host-collectors.sh")
        self.assertIn("gateway=172.30.40.9", installer)
        self.assertIn("source_address=172.30.40.11", installer)
        self.assertIn("gateway=172.30.41.9", installer)
        self.assertIn("source_address=172.30.41.11", installer)
        self.assertIn('from "${source_address}" to "${gateway}" port 9100', installer)
        self.assertIn("--node-exporter-sha256", installer)
        self.assertIn("sha256sum --binary", installer)
        self.assertIn("!= 0:0:755", installer)
        self.assertIn("--install-shared", installer)
        self.assertIn("collector-install.sha256", installer)
        self.assertIn("Refusing to replace shared collector code", installer)
        self.assertIn("unapproved ${peer_environment} exporter path became active", installer)
        self.assertNotRegex(installer, r"install -d[^\n]*-(?:o|g) (?:10003|65534)")
        self.assertIn("chown root:10003", installer)
        self.assertIn("chown 10003:10003", installer)
        self.assertIn("chown 65534:65534", installer)
        self.assertLess(installer.index("if [[ ${action} == install-shared ]]"), installer.index("install -o root -g root -m 0644"))
        self.assertNotRegex(installer, r"ufw allow[^\n]*(?:from any|to any)[^\n]*9100")

    def test_host_rollback_is_environment_scoped_and_shared_removal_is_guarded(self):
        installer = read("infra/monitoring/install-host-collectors.sh")
        rollback = read("infra/monitoring/rollback-host-collectors.sh")
        lock = "/run/lock/esmii-monitoring-host.lock"
        self.assertIn(lock, installer)
        self.assertIn(lock, rollback)
        self.assertLess(installer.index("flock --exclusive"), installer.index("ensure_directories"))
        self.assertLess(rollback.index("flock --exclusive"), rollback.index("systemctl disable --now"))
        self.assertIn("--environment", rollback)
        self.assertIn("disable-staging-monitoring", rollback)
        self.assertIn("disable-production-monitoring", rollback)
        self.assertIn("--remove-shared", rollback)
        self.assertIn(
            "Refusing shared collector removal while an environment or pull-wrapper integration is present",
            rollback,
        )
        self.assertIn("private exporter socket or listener remains active", rollback)
        self.assertIn("firewall rule remains configured", rollback)
        environment_disable = rollback[rollback.index("if [[ ${environment} == staging ]]") :]
        self.assertIn('disable_if_installed "${socket_unit}"', environment_disable)
        self.assertIn('systemctl disable --now "${unit}"', rollback)
        self.assertNotIn("esmii-log-collector.timer", environment_disable)
        self.assertNotIn("esmii-container-metrics-collector.timer", environment_disable)

    def test_collectors_are_bounded_fixed_root_oneshots_and_do_not_overlap(self):
        metrics = read("infra/systemd/esmii-container-metrics-collector.service")
        logs = read("infra/systemd/esmii-log-collector.service")
        for unit in (metrics, logs):
            self.assertIn("Type=oneshot", unit)
            self.assertIn("User=root", unit)
            self.assertIn("MemoryMax=64M", unit)
            self.assertIn("/run/lock/esmii-monitoring-collectors.lock", unit)
            self.assertNotIn("0.0.0.0", unit)
        self.assertIn("OnUnitActiveSec=15s", read("infra/systemd/esmii-container-metrics-collector.timer"))
        self.assertIn("OnUnitActiveSec=30s", read("infra/systemd/esmii-log-collector.timer"))

    def test_resource_ceiling_totals_exactly_1088_mib(self):
        dashboards = 192 * 2
        prometheus = 256 * 2
        exporter_slice = int(re.search(r"MemoryMax=(\d+)M", read("infra/systemd/esmii-node-exporter.slice")).group(1))
        collectors = sum(
            int(re.search(r"MemoryMax=(\d+)M", read(path)).group(1))
            for path in (
                "infra/systemd/esmii-container-metrics-collector.service",
                "infra/systemd/esmii-log-collector.service",
            )
        )
        self.assertEqual(dashboards + prometheus + exporter_slice + collectors, 1_088)

    def test_prometheus_configs_scrape_privately_and_drop_other_environment(self):
        staging = read("infra/monitoring/prometheus/staging/prometheus.yml")
        production = read("infra/monitoring/prometheus/production/prometheus.yml")
        for config in (staging, production):
            self.assertIn("scrape_interval: 30s", config)
            self.assertIn("scrape_timeout: 10s", config)
        self.assertIn("172.30.40.9:9100", staging)
        self.assertIn('regex: "esmii_.*;production"', staging)
        self.assertIn("172.30.41.9:9100", production)
        self.assertIn('regex: "esmii_.*;staging"', production)

    def test_alert_rules_use_only_the_approved_thresholds(self):
        rules = read("infra/monitoring/prometheus/rules/esmii.rules.yml")
        for expected in (
            'up{job="node"} == 0',
            "for: 90s",
            "> 134217728",
            "> 0.85",
            "for: 15m",
            "node_load1 > 4",
            ">= 0.60",
            ">= 0.80",
            "> 180",
            "restart_count_rolling_24h >= 1",
        ):
            self.assertIn(expected, rules)
        for undocumented in ("> 0.75", "> 0.90", "> 0.92"):
            self.assertNotIn(undocumented, rules)

    def test_caddy_exposes_only_environment_dashboard_upstreams(self):
        for path, upstream in (
            ("infra/caddy/sites/staging-dashboard.caddy", "staging-dashboard:3000"),
            ("infra/caddy/sites/production-dashboard.caddy", "production-dashboard:3000"),
        ):
            caddy = read(path)
            self.assertIn(f"reverse_proxy {upstream}", caddy)
            self.assertNotRegex(caddy.lower(), r"prometheus|node[_-]?exporter|:9090|:9100")
            self.assertIn('Strict-Transport-Security "max-age=31536000"', caddy)
            self.assertIn("https://acme-v02.api.letsencrypt.org/directory", caddy)
            self.assertIn("/api/operator-auth/*", caddy)
            self.assertIn("max_size 16KB", caddy)
            self.assertNotIn("/api/auth", caddy)

    def test_monitoring_runtime_contains_no_cadvisor(self):
        paths = [
            *list((REPOSITORY_ROOT / "infra").glob("compose.monitoring*.yaml")),
            *list((REPOSITORY_ROOT / "infra/monitoring").rglob("*")),
            *list((REPOSITORY_ROOT / "infra/systemd").glob("esmii-node-exporter*")),
        ]
        for path in paths:
            if not path.is_file() or "tests" in path.parts:
                continue
            self.assertNotIn("cadvisor", path.read_text(encoding="utf-8", errors="ignore").lower())


if __name__ == "__main__":
    unittest.main()
