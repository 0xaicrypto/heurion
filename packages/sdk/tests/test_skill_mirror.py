# SPDX-License-Identifier: Apache-2.0
"""
test_skill_mirror — NEXUS_GITHUB_MIRROR URL transformation for the
skills marketplace (GFW support). Pure unit tests, no network: only
the `_mirror` helper's rewrite rules are exercised.
"""

from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from nexus_core.skills.manager import _mirror


class MirrorDisabledTests(unittest.TestCase):
    """No env var (or empty) → every URL passes through unchanged."""

    def test_unset_env_returns_unchanged(self):
        env = {k: v for k, v in os.environ.items()
               if k != "NEXUS_GITHUB_MIRROR"}
        with patch.dict(os.environ, env, clear=True):
            url = "https://api.github.com/repos/anthropics/skills/contents/skills?ref=main"
            self.assertEqual(_mirror(url), url)

    def test_empty_env_returns_unchanged(self):
        with patch.dict(os.environ, {"NEXUS_GITHUB_MIRROR": "  "}):
            url = "https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md"
            self.assertEqual(_mirror(url), url)


class MirrorEnabledTests(unittest.TestCase):
    """ghproxy convention: mirror base + '/' + FULL original URL."""

    MIRROR = "https://ghproxy.net/"

    def _with_mirror(self, url: str) -> str:
        with patch.dict(os.environ, {"NEXUS_GITHUB_MIRROR": self.MIRROR}):
            return _mirror(url)

    def test_api_github_prefixed(self):
        url = "https://api.github.com/repos/anthropics/skills/contents/skills?ref=main"
        self.assertEqual(self._with_mirror(url),
                         "https://ghproxy.net/" + url)

    def test_raw_githubusercontent_prefixed(self):
        url = "https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md"
        self.assertEqual(self._with_mirror(url),
                         "https://ghproxy.net/" + url)

    def test_codeload_prefixed(self):
        url = "https://codeload.github.com/anthropics/skills/zip/refs/heads/main"
        self.assertEqual(self._with_mirror(url),
                         "https://ghproxy.net/" + url)

    def test_github_com_prefixed(self):
        url = "https://github.com/anthropics/skills/tree/main/skills/pdf"
        self.assertEqual(self._with_mirror(url),
                         "https://ghproxy.net/" + url)

    def test_trailing_slash_normalised(self):
        """Mirror with and without trailing slash produce the same URL
        (exactly one '/' between mirror base and original URL)."""
        url = "https://api.github.com/repos/x/y"
        with patch.dict(os.environ,
                        {"NEXUS_GITHUB_MIRROR": "https://ghproxy.net"}):
            no_slash = _mirror(url)
        with patch.dict(os.environ,
                        {"NEXUS_GITHUB_MIRROR": "https://ghproxy.net/"}):
            with_slash = _mirror(url)
        self.assertEqual(no_slash, with_slash)
        self.assertEqual(no_slash, "https://ghproxy.net/" + url)

    def test_non_github_url_never_rewritten(self):
        """The mirror must never see non-GitHub traffic."""
        for url in (
            "https://example.com/api/thing",
            "https://api.moonshot.cn/v1/chat",
            "https://notgithub.com/owner/repo",
        ):
            self.assertEqual(self._with_mirror(url), url)

    def test_garbage_url_returned_unchanged(self):
        self.assertEqual(self._with_mirror("not-a-url"), "not-a-url")


if __name__ == "__main__":
    unittest.main()
