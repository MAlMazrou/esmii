from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
MONITORING_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MONITORING_ROOT))

from monitoring_overlay_state import active_compose_files  # noqa: E402
from render_monitoring import (  # noqa: E402
    SOURCE,
    host_operation_lock,
    render_runtime,
    validate_inputs,
)
from rollback_monitoring_runtime import (  # noqa: E402
    purge_secret_handoff,
    rollback,
    verify_runtime_detached,
)


DASHBOARD_IMAGE = "ghcr.io/malmazrou/esmii-dashboard@sha256:" + "a" * 64
PROMETHEUS_IMAGE = "prom/prometheus@sha256:" + "b" * 64
REVISION = "c" * 40
VERSION = "v0.1.2"
HOST_PAYLOAD_DIGEST = "sha256:" + "d" * 64


class RuntimeRenderingTests(unittest.TestCase):
    def test_staging_render_is_digest_only_deterministic_and_environment_local(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = render_runtime(
                environment="staging",
                source_root=REPOSITORY_ROOT / "infra",
                runtime_root=root,
                dashboard_image=DASHBOARD_IMAGE,
                prometheus_image=PROMETHEUS_IMAGE,
                source=SOURCE,
                revision=REVISION,
                version=VERSION,
                host_payload_digest=HOST_PAYLOAD_DIGEST,
            )
            compose = (root / "compose.monitoring.staging.yaml").read_text(encoding="utf-8")
            edge_compose = (root / "compose.monitoring.staging.edge.yaml").read_text(
                encoding="utf-8"
            )
            persisted = json.loads(
                (root / "monitoring/runtime-manifest.staging.json").read_text(encoding="utf-8")
            )
            staging_rules_exist = (
                root / "monitoring/prometheus/staging/rules/esmii.rules.yml"
            ).is_file()

        self.assertEqual(manifest, persisted)
        self.assertIn(DASHBOARD_IMAGE, compose)
        self.assertIn(PROMETHEUS_IMAGE, compose)
        self.assertNotIn("@@", compose)
        self.assertNotIn("/var/lib/esmii/monitoring/production/", compose)
        self.assertNotIn("production-monitoring", compose)
        self.assertNotIn("caddy:", compose)
        self.assertIn("staging-dashboard.caddy", edge_compose)
        self.assertIn("name: esmii-monitoring-staging-dashboard-secret", compose)
        self.assertIn("app.esmii.component: dashboard-secret-handoff", compose)
        self.assertIn("app.esmii.environment: staging", compose)
        self.assertTrue(staging_rules_exist)

    def test_renderer_refuses_in_place_replacement_of_an_immutable_candidate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            render_runtime(
                environment="staging",
                source_root=REPOSITORY_ROOT / "infra",
                runtime_root=root,
                dashboard_image=DASHBOARD_IMAGE,
                prometheus_image=PROMETHEUS_IMAGE,
                source=SOURCE,
                revision=REVISION,
                version=VERSION,
                host_payload_digest=HOST_PAYLOAD_DIGEST,
            )
            with self.assertRaisesRegex(ValueError, "different immutable"):
                render_runtime(
                    environment="staging",
                    source_root=REPOSITORY_ROOT / "infra",
                    runtime_root=root,
                    dashboard_image=DASHBOARD_IMAGE,
                    prometheus_image=PROMETHEUS_IMAGE,
                    source=SOURCE,
                    revision="d" * 40,
                    version=VERSION,
                    host_payload_digest=HOST_PAYLOAD_DIGEST,
                )
            persisted = json.loads(
                (root / "monitoring/runtime-manifest.staging.json").read_text(encoding="utf-8")
            )
            self.assertEqual(persisted["provenance"]["revision"], REVISION)

    def test_manifest_is_inert_and_private_and_edge_markers_are_both_required(self):
        with tempfile.TemporaryDirectory() as temporary, tempfile.TemporaryDirectory() as state:
            root = Path(temporary)
            state_root = Path(state)
            render_runtime(
                environment="staging",
                source_root=REPOSITORY_ROOT / "infra",
                runtime_root=root,
                dashboard_image=DASHBOARD_IMAGE,
                prometheus_image=PROMETHEUS_IMAGE,
                source=SOURCE,
                revision=REVISION,
                version=VERSION,
                host_payload_digest=HOST_PAYLOAD_DIGEST,
            )
            render_runtime(
                environment="production",
                source_root=REPOSITORY_ROOT / "infra",
                runtime_root=root,
                dashboard_image=DASHBOARD_IMAGE,
                prometheus_image=PROMETHEUS_IMAGE,
                source=SOURCE,
                revision=REVISION,
                version=VERSION,
                host_payload_digest=HOST_PAYLOAD_DIGEST,
            )
            self.assertEqual(
                [path.name for path in active_compose_files(runtime_root=root, state_root=state_root)],
                [],
            )
            edge_marker = state_root / "staging" / "edge-enabled"
            edge_marker.parent.mkdir(parents=True)
            edge_marker.write_text("enabled\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "without its private runtime"):
                active_compose_files(runtime_root=root, state_root=state_root)
            edge_marker.unlink()
            private_marker = state_root / "staging" / "private-enabled"
            private_marker.write_text("enabled\n", encoding="utf-8")
            self.assertEqual(
                [path.name for path in active_compose_files(runtime_root=root, state_root=state_root)],
                ["compose.monitoring.staging.yaml"],
            )
            edge_marker.write_text("enabled\n", encoding="utf-8")
            self.assertEqual(
                [path.name for path in active_compose_files(runtime_root=root, state_root=state_root)],
                [
                    "compose.monitoring.staging.yaml",
                    "compose.monitoring.staging.edge.yaml",
                ],
            )
            (root / "compose.monitoring.staging.yaml").write_text("tampered\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "hash differs"):
                active_compose_files(runtime_root=root, state_root=state_root)

    def test_shared_host_operation_lock_rejects_a_concurrent_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            lock = Path(temporary) / "host-pull.lock"
            with host_operation_lock(lock, timeout_seconds=0.1):
                with self.assertRaisesRegex(TimeoutError, "shared host-operation lock"):
                    with host_operation_lock(lock, timeout_seconds=0.02):
                        self.fail("a concurrent mutation unexpectedly acquired the shared lock")

    def test_concurrent_candidates_cannot_mix_manifest_and_rendered_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            worker = (
                "import sys; from pathlib import Path; "
                f"sys.path.insert(0, {str(MONITORING_ROOT)!r}); "
                "from render_monitoring import render_runtime; "
                "render_runtime(environment='staging', source_root=Path(sys.argv[1]), "
                "runtime_root=Path(sys.argv[2]), dashboard_image=sys.argv[3], "
                "prometheus_image=sys.argv[4], source=sys.argv[5], revision=sys.argv[6], "
                "version=sys.argv[7], host_payload_digest=sys.argv[8])"
            )
            base = [
                sys.executable,
                "-c",
                worker,
                str(REPOSITORY_ROOT / "infra"),
                str(root),
            ]
            first = subprocess.Popen(
                [
                    *base,
                    DASHBOARD_IMAGE,
                    PROMETHEUS_IMAGE,
                    SOURCE,
                    REVISION,
                    VERSION,
                    HOST_PAYLOAD_DIGEST,
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            second = subprocess.Popen(
                [
                    *base,
                    "ghcr.io/malmazrou/esmii-dashboard@sha256:" + "d" * 64,
                    PROMETHEUS_IMAGE,
                    SOURCE,
                    "e" * 40,
                    VERSION,
                    HOST_PAYLOAD_DIGEST,
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            first.communicate(timeout=10)
            second.communicate(timeout=10)
            self.assertEqual(sorted((first.returncode, second.returncode)), [0, 1])
            manifest = json.loads(
                (root / "monitoring/runtime-manifest.staging.json").read_text(encoding="utf-8")
            )
            for relative, expected_hash in manifest["files"].items():
                actual_hash = hashlib.sha256((root / relative).read_bytes()).hexdigest()
                self.assertEqual(actual_hash, expected_hash)

    def test_mutable_or_noncanonical_images_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "immutable canonical GHCR"):
            validate_inputs(
                "ghcr.io/malmazrou/esmii-dashboard:main",
                PROMETHEUS_IMAGE,
                SOURCE,
                REVISION,
                VERSION,
            )
        with self.assertRaisesRegex(ValueError, "official-image digest"):
            validate_inputs(
                DASHBOARD_IMAGE,
                "example.invalid/prometheus@sha256:" + "b" * 64,
                SOURCE,
                REVISION,
                VERSION,
            )

    def test_renderer_rejects_intermediate_destination_symlinks_before_writing(self):
        with tempfile.TemporaryDirectory() as temporary, tempfile.TemporaryDirectory() as outside:
            root = Path(temporary)
            (root / "caddy").symlink_to(Path(outside), target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "contains a symlink"):
                render_runtime(
                    environment="staging",
                    source_root=REPOSITORY_ROOT / "infra",
                    runtime_root=root,
                    dashboard_image=DASHBOARD_IMAGE,
                    prometheus_image=PROMETHEUS_IMAGE,
                    source=SOURCE,
                    revision=REVISION,
                    version=VERSION,
                    host_payload_digest=HOST_PAYLOAD_DIGEST,
                )
            self.assertFalse((root / "compose.monitoring.staging.yaml").exists())

    def test_environment_rollback_removes_only_rendered_config_and_preserves_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for environment in ("staging", "production"):
                render_runtime(
                    environment=environment,
                    source_root=REPOSITORY_ROOT / "infra",
                    runtime_root=root,
                    dashboard_image=DASHBOARD_IMAGE,
                    prometheus_image=PROMETHEUS_IMAGE,
                    source=SOURCE,
                    revision=REVISION,
                    version=VERSION,
                    host_payload_digest=HOST_PAYLOAD_DIGEST,
                )
            state = root / "state-must-survive"
            state.write_text("preserved\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "confirmation"):
                rollback(environment="production", runtime_root=root, confirmation="wrong")
            def detached_runner(arguments, **_kwargs):
                return subprocess.CompletedProcess(arguments, 0, "", "")
            rollback(
                environment="production",
                runtime_root=root,
                confirmation="remove-production-monitoring-config",
                runner=detached_runner,
            )
            self.assertFalse((root / "compose.monitoring.production.yaml").exists())
            self.assertFalse((root / "compose.monitoring.production.edge.yaml").exists())
            self.assertTrue((root / "compose.monitoring.staging.yaml").is_file())
            self.assertTrue((root / "compose.monitoring.staging.edge.yaml").is_file())
            self.assertFalse(
                (root / "monitoring/prometheus/production/rules/esmii.rules.yml").exists()
            )
            self.assertTrue(
                (root / "monitoring/prometheus/staging/rules/esmii.rules.yml").is_file()
            )
            self.assertEqual(state.read_text(encoding="utf-8"), "preserved\n")

    def test_rollback_requires_manager_to_remove_activation_marker_after_detach(self):
        with tempfile.TemporaryDirectory() as temporary, tempfile.TemporaryDirectory() as state:
            root = Path(temporary)
            state_root = Path(state)
            render_runtime(
                environment="staging",
                source_root=REPOSITORY_ROOT / "infra",
                runtime_root=root,
                dashboard_image=DASHBOARD_IMAGE,
                prometheus_image=PROMETHEUS_IMAGE,
                source=SOURCE,
                revision=REVISION,
                version=VERSION,
                host_payload_digest=HOST_PAYLOAD_DIGEST,
            )
            marker = state_root / "staging" / "private-enabled"
            marker.parent.mkdir(parents=True)
            marker.write_text("enabled\n", encoding="utf-8")
            marker.chmod(0o600)

            def detached_runner(arguments, **_kwargs):
                return subprocess.CompletedProcess(arguments, 0, "", "")

            with self.assertRaisesRegex(ValueError, "runtime manager stop action"):
                rollback(
                    environment="staging",
                    runtime_root=root,
                    confirmation="remove-staging-monitoring-config",
                    runner=detached_runner,
                    state_root=state_root,
                )
            self.assertTrue(marker.is_file())
            self.assertTrue((root / "compose.monitoring.staging.yaml").is_file())

    def test_rollback_refuses_existing_monitoring_or_caddy_edge_attachments(self):
        dashboard_id = "a" * 64

        def dashboard_runner(arguments, **_kwargs):
            arguments = tuple(arguments)
            if arguments[1:4] == ("container", "ls", "--all") and any(
                value.endswith("staging-dashboard") for value in arguments
            ):
                return subprocess.CompletedProcess(arguments, 0, dashboard_id + "\n", "")
            return subprocess.CompletedProcess(arguments, 0, "", "")

        with self.assertRaisesRegex(ValueError, "staging-dashboard"):
            verify_runtime_detached(environment="staging", runner=dashboard_runner)

        caddy_id = "b" * 64

        def caddy_runner(arguments, **_kwargs):
            arguments = tuple(arguments)
            if arguments[1:4] == ("container", "ls", "--all") and any(
                value.endswith("service=caddy") for value in arguments
            ):
                return subprocess.CompletedProcess(arguments, 0, caddy_id + "\n", "")
            if arguments[1:3] == ("container", "inspect"):
                record = {
                    "Mounts": [],
                    "NetworkSettings": {
                        "Networks": {"esmii_staging-monitoring-edge": {}}
                    },
                }
                return subprocess.CompletedProcess(arguments, 0, json.dumps([record]), "")
            return subprocess.CompletedProcess(arguments, 0, "", "")

        with self.assertRaisesRegex(ValueError, "Caddy remains attached"):
            verify_runtime_detached(environment="staging", runner=caddy_runner)

    def test_secret_handoff_purge_targets_only_the_fixed_detached_volume(self):
        volume = "esmii-monitoring-staging-dashboard-secret"
        calls: list[tuple[str, ...]] = []

        def runner(arguments, **_kwargs):
            arguments = tuple(arguments)
            calls.append(arguments)
            if arguments[1:3] == ("volume", "inspect"):
                metadata = [
                    {
                        "Name": volume,
                        "Labels": {
                            "app.esmii.component": "dashboard-secret-handoff",
                            "app.esmii.environment": "staging",
                        },
                    }
                ]
                return subprocess.CompletedProcess(arguments, 0, json.dumps(metadata), "")
            if arguments[1:3] == ("container", "ls"):
                return subprocess.CompletedProcess(arguments, 0, "", "")
            if arguments[1:3] == ("volume", "rm"):
                return subprocess.CompletedProcess(arguments, 0, volume + "\n", "")
            self.fail(f"unexpected command: {arguments}")

        self.assertTrue(purge_secret_handoff(environment="staging", runner=runner))
        self.assertEqual(calls[-1], ("/usr/bin/docker", "volume", "rm", volume))

    def test_secret_handoff_purge_rejects_wrong_or_missing_identity_labels(self):
        volume = "esmii-monitoring-production-dashboard-secret"
        for labels in ({}, {"app.esmii.component": "unrelated"}):
            with self.subTest(labels=labels):
                def runner(arguments, **_kwargs):
                    metadata = [{"Name": volume, "Labels": labels}]
                    return subprocess.CompletedProcess(arguments, 0, json.dumps(metadata), "")

                with self.assertRaisesRegex(ValueError, "identity labels"):
                    purge_secret_handoff(environment="production", runner=runner)


if __name__ == "__main__":
    unittest.main()
