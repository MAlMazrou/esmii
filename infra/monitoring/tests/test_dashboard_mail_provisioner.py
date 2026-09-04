from __future__ import annotations

import sys
import tempfile
import unittest
import urllib.parse
from pathlib import Path
from unittest.mock import patch


MONITORING_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MONITORING_ROOT))

from provision_dashboard_mail import (  # noqa: E402
    ADMIN_ORIGIN,
    ADVERTISED_ORIGIN,
    MAIL_HOSTNAME,
    StalwartAdmin,
    atomic_secret,
    parse_existing_smtp_url,
    query_account,
    validate_account,
)


class DashboardMailProvisionerTests(unittest.TestCase):
    def test_admin_accepts_only_the_canonical_advertised_jmap_origin(self):
        class Admin(StalwartAdmin):
            session = {"apiUrl": f"{ADVERTISED_ORIGIN}/jmap/"}

            def request(self, method, path, body=None):
                self.requested = (method, path, body)
                return self.session

        admin = Admin("admin", "password")
        self.assertEqual(admin.api_path, "/jmap/")
        self.assertEqual(admin.requested, ("GET", "/jmap/session", None))
        self.assertEqual(ADMIN_ORIGIN, "http://172.30.30.2:8080")

        for api_url in (
            f"{ADMIN_ORIGIN}/jmap/",
            "http://mail.esmii.app/jmap/",
            "https://other.example/jmap/",
            f"{ADVERTISED_ORIGIN}:8443/jmap/",
            f"{ADVERTISED_ORIGIN}/api/",
            f"{ADVERTISED_ORIGIN}/jmap/?redirect=other",
        ):
            with self.subTest(api_url=api_url), self.assertRaisesRegex(
                ValueError, "unsafe API URL"
            ):
                Admin.session = {"apiUrl": api_url}
                Admin("admin", "password")

    def test_existing_secret_requires_exact_environment_sender_and_starttls(self):
        email = "monitoring-staging@esmii.app"
        password = "A" * 32
        url = (
            "smtp://"
            + urllib.parse.quote(email, safe="")
            + ":"
            + password
            + f"@{MAIL_HOSTNAME}:587?requireTLS=true"
        )
        self.assertEqual(parse_existing_smtp_url(url, email), password)

        invalid = (
            url.replace(email.replace("@", "%40"), "monitoring%40esmii.app"),
            url.replace(":587", ":25"),
            url.replace("requireTLS=true", "requireTLS=false"),
            url.replace("smtp://", "smtps://"),
        )
        for value in invalid:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "unexpected shape"):
                parse_existing_smtp_url(value, email)

    def test_account_query_accepts_only_nonempty_string_identifiers(self):
        class Admin:
            def __init__(self, result):
                self.result = result

            def jmap(self, method, arguments):
                self.method = method
                self.arguments = arguments
                return self.result

        admin = Admin({"ids": ["account-id"]})
        self.assertEqual(query_account(admin, "monitoring-staging"), ["account-id"])
        self.assertEqual(admin.method, "x:Account/query")
        self.assertEqual(admin.arguments, {"filter": {"name": "monitoring-staging"}})

        for result in ({}, {"ids": "account-id"}, {"ids": [""]}, {"ids": [7]}):
            with self.subTest(result=result), self.assertRaisesRegex(ValueError, "invalid account"):
                query_account(Admin(result), "monitoring-staging")

    def test_existing_account_must_be_the_expected_user_in_the_esmii_domain(self):
        class Admin:
            def __init__(self, account):
                self.account = account

            def jmap(self, method, arguments):
                self.method = method
                self.arguments = arguments
                return {"list": [self.account]}

        account = {
            "@type": "User",
            "domainId": "b",
            "id": "account-id",
            "name": "monitoring-staging",
        }
        admin = Admin(account)
        validate_account(admin, "account-id", "monitoring-staging")
        self.assertEqual(admin.method, "x:Account/get")
        self.assertEqual(admin.arguments["ids"], ["account-id"])

        for invalid in (
            {**account, "@type": "Group"},
            {**account, "domainId": "other"},
            {**account, "id": "other"},
            {**account, "name": "monitoring"},
        ):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(
                ValueError, "environment contract"
            ):
                validate_account(Admin(invalid), "account-id", "monitoring-staging")

    def test_atomic_secret_is_mode_0600_and_replaces_without_partial_content(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "dashboard-smtp-url"
            with patch("provision_dashboard_mail.os.chown"):
                atomic_secret(path, "first")
                atomic_secret(path, "second")
            self.assertEqual(path.read_text(encoding="utf-8"), "second\n")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(list(path.parent.glob(f".{path.name}.*")), [])


if __name__ == "__main__":
    unittest.main()
