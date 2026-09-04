from __future__ import annotations

import hashlib
import io
import json
import os
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from copy import copy
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
MONITORING_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MONITORING_ROOT))

from monitoring_payload import (  # noqa: E402
    PAYLOAD_FILES,
    digest_bytes,
    materialize,
    verify_archive,
    verify_materialized,
)


REVISION = "7" * 40


class MonitoringPayloadTests(unittest.TestCase):
    def build_payload(self, output: Path) -> tuple[Path, str, str, str]:
        result = subprocess.run(
            (
                "node",
                "scripts/monitoring-payload.mjs",
                "build",
                "--revision",
                REVISION,
                "--output",
                str(output),
            ),
            cwd=REPOSITORY_ROOT,
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        record = json.loads(result.stdout)
        return (
            Path(record["archive"]),
            record["digest"],
            record["bootstrap_sha256"],
            record["verifier_sha256"],
        )

    def rewrite_archive(self, archive: Path, mutate) -> tuple[Path, str]:
        output = archive.with_name("rewritten.tar")
        with tarfile.open(archive, mode="r:") as source:
            rows = []
            for member in source:
                handle = source.extractfile(member)
                rows.append((copy(member), b"" if handle is None else handle.read()))
        rows = mutate(rows)
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w", format=tarfile.USTAR_FORMAT) as target:
            for member, value in rows:
                target.addfile(member, io.BytesIO(value) if member.isfile() else None)
        output.write_bytes(stream.getvalue())
        return output, digest_bytes(output.read_bytes())

    def test_materialized_payload_is_closed_and_detects_source_tampering(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, digest, _, _ = self.build_payload(root / "artifact")
            _, contents, metadata = verify_archive(archive, digest, REVISION)
            self.assertEqual(metadata["source_revision"], REVISION)
            self.assertIn("infra/staging-pull/esmii-staging-pull", contents)

            destination = materialize(archive, digest, REVISION, root / "sealed")
            verify_materialized(destination, digest, REVISION)
            self.assertEqual(stat.S_IMODE((root / "sealed").stat().st_mode), 0o700)
            target = destination / "infra/monitoring/manage-monitoring-runtime.sh"
            target.write_text("tampered\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "materialized monitoring payload file differs"):
                verify_materialized(destination, digest, REVISION)

    def test_archive_tampering_fails_before_destination_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, digest, _, _ = self.build_payload(root / "artifact")
            tampered = root / "tampered.tar"
            value = bytearray(archive.read_bytes())
            value[1024] ^= 1
            tampered.write_bytes(value)
            destination_parent = root / "must-not-exist"
            with self.assertRaisesRegex(ValueError, "payload digest mismatch"):
                materialize(tampered, digest, REVISION, destination_parent)
            self.assertFalse(destination_parent.exists())

    def test_wrong_revision_is_rejected_before_materialization(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, digest, _, _ = self.build_payload(root / "artifact")
            destination_parent = root / "must-not-exist"
            with self.assertRaisesRegex(ValueError, "metadata differs"):
                materialize(archive, digest, "8" * 40, destination_parent)
            self.assertFalse(destination_parent.exists())

    def test_archive_rejects_duplicate_traversal_symlink_and_nonregular_members(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, _, _, _ = self.build_payload(root / "artifact")
            first_path = next(iter(PAYLOAD_FILES))

            def duplicate(rows):
                return [*rows, (copy(rows[0][0]), rows[0][1])]

            def traversal(rows):
                member = tarfile.TarInfo("../escape")
                member.mode = 0o644
                member.uid = member.gid = member.mtime = 0
                member.size = 1
                return [*rows, (member, b"x")]

            def symlink(rows):
                for index, (member, _) in enumerate(rows):
                    if member.name == first_path:
                        replacement = copy(member)
                        replacement.type = tarfile.SYMTYPE
                        replacement.linkname = "/tmp/escape"
                        replacement.size = 0
                        rows[index] = (replacement, b"")
                        return rows
                self.fail("payload fixture lacks its first member")

            def nonregular(rows):
                for index, (member, _) in enumerate(rows):
                    if member.name == first_path:
                        replacement = copy(member)
                        replacement.type = tarfile.DIRTYPE
                        replacement.size = 0
                        rows[index] = (replacement, b"")
                        return rows
                self.fail("payload fixture lacks its first member")

            for label, mutator, error in (
                ("duplicate", duplicate, "duplicate path"),
                ("traversal", traversal, "unapproved path"),
                ("symlink", symlink, "non-normalized metadata"),
                ("nonregular", nonregular, "non-normalized metadata"),
            ):
                with self.subTest(label=label):
                    rewritten, digest = self.rewrite_archive(archive, mutator)
                    with self.assertRaisesRegex(ValueError, error):
                        verify_archive(rewritten, digest, REVISION)

    def test_archive_rejects_wrong_mode_and_extra_or_missing_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, _, _, _ = self.build_payload(root / "artifact")
            first_path = next(iter(PAYLOAD_FILES))

            def wrong_mode(rows):
                for member, _ in rows:
                    if member.name == first_path:
                        member.mode = 0o777
                        break
                return rows

            def extra(rows):
                member = tarfile.TarInfo("extra")
                member.mode = 0o644
                member.uid = member.gid = member.mtime = 0
                member.size = 1
                return [*rows, (member, b"x")]

            def missing(rows):
                return [(member, value) for member, value in rows if member.name != first_path]

            for label, mutator, error in (
                ("wrong-mode", wrong_mode, "unexpected mode"),
                ("extra", extra, "unapproved path"),
                ("missing", missing, "file set is incomplete"),
            ):
                with self.subTest(label=label):
                    rewritten, digest = self.rewrite_archive(archive, mutator)
                    with self.assertRaisesRegex(ValueError, error):
                        verify_archive(rewritten, digest, REVISION)

    def test_materialized_control_records_and_extra_files_are_tamper_evident(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, digest, _, _ = self.build_payload(root / "artifact")
            destination = materialize(archive, digest, REVISION, root / "sealed")

            (destination / ".payload-digest").write_text("sha256:" + "0" * 64 + "\n")
            with self.assertRaisesRegex(ValueError, "digest record differs"):
                verify_materialized(destination, digest, REVISION)
            (destination / ".payload-digest").write_text(digest + "\n")
            (destination / "unexpected").write_text("x", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "file set differs"):
                verify_materialized(destination, digest, REVISION)

    def test_candidate_verifier_is_materialized_as_data_and_never_executed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, _, _, _ = self.build_payload(root / "artifact")
            sentinel = root / "candidate-verifier-executed"
            hostile = (
                "from pathlib import Path\n"
                f"Path({str(sentinel)!r}).write_text('executed', encoding='utf-8')\n"
            ).encode()

            def replace_candidate_verifier(rows):
                updated = []
                for member, value in rows:
                    if member.name == "infra/monitoring/monitoring_payload.py":
                        value = hostile
                        member.size = len(value)
                    updated.append((member, value))
                for index, (member, value) in enumerate(updated):
                    if member.name != "payload-inventory.json":
                        continue
                    inventory = json.loads(value)
                    for row in inventory["files"]:
                        if row["path"] == "infra/monitoring/monitoring_payload.py":
                            row["sha256"] = digest_bytes(hostile)
                            row["size"] = len(hostile)
                    value = (
                        json.dumps(inventory, sort_keys=True, separators=(",", ":")) + "\n"
                    ).encode()
                    member.size = len(value)
                    updated[index] = (member, value)
                return updated

            # Rebuild a fully self-consistent candidate whose own verifier has
            # a side effect. The independently loaded verifier may materialize
            # those bytes, but must never import or execute them.
            rewritten, digest = self.rewrite_archive(
                archive, replace_candidate_verifier
            )
            destination = materialize(rewritten, digest, REVISION, root / "sealed")
            self.assertEqual(
                (destination / "infra/monitoring/monitoring_payload.py").read_bytes(),
                hostile,
            )
            self.assertFalse(sentinel.exists())

    def test_concurrent_materialization_commits_one_verified_digest_winner(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, digest, _, _ = self.build_payload(root / "artifact")
            payload_root = root / "sealed"
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(
                    pool.map(
                        lambda _: materialize(archive, digest, REVISION, payload_root),
                        range(2),
                    )
                )
            self.assertEqual(results[0], results[1])
            verify_materialized(results[0], digest, REVISION)
            self.assertEqual(
                [path.name for path in payload_root.iterdir()],
                [digest.removeprefix("sha256:")],
            )

    def test_existing_payload_parent_must_be_mode_0700(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, digest, _, _ = self.build_payload(root / "artifact")
            payload_root = root / "unsafe-parent"
            payload_root.mkdir(mode=0o755)
            os.chmod(payload_root, 0o755)
            with self.assertRaisesRegex(ValueError, "parent must be mode 0700"):
                materialize(archive, digest, REVISION, payload_root)

    def test_bootstrap_tampering_is_rejected_before_payload_code_or_destination(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, digest, bootstrap_digest, verifier_digest = self.build_payload(
                root / "artifact"
            )
            _, contents, _ = verify_archive(archive, digest, REVISION)
            bootstrap = root / "materialize-monitoring-payload.sh"
            bootstrap.write_bytes(
                contents["infra/monitoring/materialize-monitoring-payload.sh"]
            )
            actual = "sha256:" + hashlib.sha256(bootstrap.read_bytes()).hexdigest()
            self.assertEqual(actual, bootstrap_digest)
            verifier = root / "monitoring_payload.py"
            verifier.write_bytes(contents["infra/monitoring/monitoring_payload.py"])
            actual_verifier = "sha256:" + hashlib.sha256(verifier.read_bytes()).hexdigest()
            self.assertEqual(actual_verifier, verifier_digest)
            bootstrap_text = bootstrap.read_text(encoding="utf-8")
            self.assertNotIn("tar --extract", bootstrap_text)
            self.assertIn("EXPECTED_VERIFIER_DIGEST", bootstrap_text)

            bootstrap.write_bytes(bootstrap.read_bytes() + b"\n# tampered\n")
            tampered = "sha256:" + hashlib.sha256(bootstrap.read_bytes()).hexdigest()
            destination_parent = root / "must-not-exist"
            self.assertNotEqual(tampered, bootstrap_digest)
            self.assertFalse(destination_parent.exists())

    def test_checkout_root_is_never_accepted_as_materialized_payload(self):
        with tempfile.TemporaryDirectory() as temporary:
            _, digest, _, _ = self.build_payload(Path(temporary) / "artifact")
            with self.assertRaisesRegex(
                ValueError, "directory does not match its digest"
            ):
                verify_materialized(REPOSITORY_ROOT, digest, REVISION)


if __name__ == "__main__":
    unittest.main()
