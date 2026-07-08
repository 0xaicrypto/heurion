"""
Source-level guards for the desktop-v2 i18n system.

What we lock down
─────────────────
1. zh-CN.ts and en-US.ts have IDENTICAL key sets. The TS Dict type
   should already enforce this at build time, but a regression where
   someone changes the type to `Partial<Dict>` (or zh-CN to `as
   const`) would silently drop strings to English fallback. We
   re-check at source level so a Python test catches the drift.

2. zh-CN values contain at least SOME Chinese characters across the
   file — catches a regression where someone copies en-US into zh-CN
   and forgets to translate. We're not strict about every value (some
   like "Nexus" / "API" / "MRN" / "PHI" / "SMTP" stay English by
   policy), but the file as a whole must be majority CJK.

3. ``useT`` and ``locale`` plumbing wire-in:
     - store.ts owns ``locale`` + ``setLocale``
     - lib/i18n exports ``useT``, ``Locale``, ``DEFAULT_LOCALE``
     - default locale is zh-CN (target audience: Chinese clinicians)
     - localStorage key is 'nexus.locale'

4. AccountMenu renders a language toggle calling ``setLocale``.

5. ``MODE_LABELS`` no longer hard-codes the English mode labels —
   layout.tsx + ModeTabs read via ``useModeLabel`` / t() so a switch
   to zh-CN actually changes the tab text. (We don't delete
   MODE_LABELS — modes.tsx::ModeStub still uses ModeKind shape — but
   call sites in chrome should route through i18n.)
"""
from __future__ import annotations

import pathlib
import re

DESKTOP_SRC = (
    pathlib.Path(__file__).resolve().parents[2] / "desktop-v2" / "src"
)


def _read(rel: str) -> str:
    p = DESKTOP_SRC / rel
    assert p.exists(), f"missing file: {p}"
    return p.read_text()


def _extract_keys(ts_src: str) -> set[str]:
    """Pull every dictionary key from one of the en-US/zh-CN .ts files.
    The dictionary literal has the shape ``'foo.bar': '…',`` — we
    match keys quoted with a single quote at line start (after
    optional whitespace) followed by ``:``."""
    # Match either single or double quoted keys at start of line (after
    # whitespace). We don't try to be clever about embedded quotes in
    # values — the key syntax is rigid.
    pattern = re.compile(r"""^\s*['"]([a-zA-Z][a-zA-Z0-9._]*)['"]\s*:""", re.MULTILINE)
    return set(pattern.findall(ts_src))


def test_en_and_zh_have_identical_key_sets():
    en = _read("lib/i18n/en-US.ts")
    zh = _read("lib/i18n/zh-CN.ts")
    en_keys = _extract_keys(en)
    zh_keys = _extract_keys(zh)

    missing_in_zh = en_keys - zh_keys
    extra_in_zh   = zh_keys - en_keys

    assert not missing_in_zh, (
        f"{len(missing_in_zh)} key(s) defined in en-US.ts are missing "
        "from zh-CN.ts — those strings will fall back to English at "
        f"runtime. Missing: {sorted(list(missing_in_zh))[:15]}"
        + (" …" if len(missing_in_zh) > 15 else "")
    )
    assert not extra_in_zh, (
        f"{len(extra_in_zh)} key(s) in zh-CN.ts have no en-US.ts "
        f"counterpart. Either add them to en-US.ts or remove them "
        f"from zh-CN.ts. Extras: {sorted(list(extra_in_zh))[:15]}"
        + (" …" if len(extra_in_zh) > 15 else "")
    )

    # And we should have a non-trivial number of keys overall — guards
    # against an accidental "keys both empty" pass.
    assert len(en_keys) >= 100, (
        f"en-US.ts only has {len(en_keys)} keys — the chrome alone "
        "should be ≥100. Did the file get truncated?"
    )


def test_zh_values_are_actually_chinese():
    """Make sure zh-CN.ts isn't an accidental copy-paste of en-US.ts.
    We count what fraction of the values contain ≥1 CJK ideograph and
    require ≥60% (some values like 'API' / 'SMTP' / 'Nexus' / 'esc'
    legitimately stay roman)."""
    zh = _read("lib/i18n/zh-CN.ts")

    # Extract every quoted value on a key-line. Values can use single
    # or double quotes; matching them tightly is enough for our format.
    value_pattern = re.compile(
        r"^\s*['\"][a-zA-Z][a-zA-Z0-9._]*['\"]\s*:\s*['\"]([^'\"\n]*)['\"]",
        re.MULTILINE,
    )
    values = value_pattern.findall(zh)
    assert len(values) >= 100, f"only {len(values)} values extracted"

    cjk_re = re.compile(r"[一-鿿]")
    cjk_values = [v for v in values if cjk_re.search(v)]

    cjk_fraction = len(cjk_values) / len(values)
    assert cjk_fraction >= 0.55, (
        f"Only {cjk_fraction:.0%} of zh-CN values contain Chinese "
        f"characters ({len(cjk_values)}/{len(values)}). Likely a "
        "regression where someone copy-pasted en-US.ts and forgot to "
        "translate. (Threshold 55% accounts for legitimate roman-only "
        "values like 'API' / 'SMTP' / 'Nexus' / 'esc'.)"
    )


def test_default_locale_is_zh_cn():
    """Per the original spec — target audience is Chinese clinicians,
    so fresh installs should boot in zh-CN. en-US is a one-click
    toggle in the AccountMenu."""
    src = _read("lib/i18n/index.ts")
    assert re.search(
        r"DEFAULT_LOCALE\s*:\s*Locale\s*=\s*['\"]zh-CN['\"]",
        src,
    ), (
        "DEFAULT_LOCALE in lib/i18n/index.ts is not 'zh-CN'. New users "
        "would land in English which contradicts the product target."
    )


def test_localstorage_key_is_namespaced():
    """The localStorage key should be 'nexus.locale' — namespaced under
    the app to coexist with other localStorage users without
    collision. (We also assert the key constant exists; a raw string
    literal scattered across two files breaks atomicity.)"""
    src = _read("lib/i18n/index.ts")
    assert "LOCALE_STORAGE_KEY = 'nexus.locale'" in src \
        or 'LOCALE_STORAGE_KEY = "nexus.locale"' in src, (
        "LOCALE_STORAGE_KEY constant is missing or not 'nexus.locale'. "
        "Persistence relies on a single shared key — don't hard-code "
        "the string in two files."
    )


def test_store_has_locale_state():
    """``locale`` + ``setLocale`` must be present on the Zustand store
    so any component can subscribe via useAppState."""
    src = _read("store.ts")
    for name in ("locale", "setLocale", "readStoredLocale", "writeStoredLocale"):
        assert name in src, (
            f"store.ts no longer references {name} — i18n plumbing "
            "broken. Components reading useAppState((s) => s.locale) "
            "would see undefined."
        )


def test_account_menu_renders_language_toggle():
    """User-facing requirement: language toggle lives in the
    AccountMenu so the medic can switch without hunting through
    settings. AccountMenu is in components/overlays.tsx."""
    src = _read("components/overlays.tsx")
    # The Globe icon import is the easiest tell — that icon is only
    # used for the language toggle.
    assert "Globe" in src, (
        "AccountMenu no longer imports the Globe icon — that's the "
        "language toggle marker. Toggle UI was removed?"
    )
    # And setLocale must actually be called from the menu.
    assert "setLocale(" in src, (
        "AccountMenu has the Globe import but no setLocale() call — "
        "clicking the language row would be a no-op."
    )


def test_layout_routes_mode_labels_through_i18n():
    """Layout.tsx ModeTabs must use useModeLabel() (or t('mode.*'))
    rather than reading the English MODE_LABELS directly. Without
    this, switching to zh-CN leaves the mode tabs in English while
    everything else translates."""
    src = _read("components/layout.tsx")
    assert "useModeLabel" in src or re.search(
        r"t\(\s*['\"]mode\.\w+['\"]", src,
    ), (
        "layout.tsx doesn't route mode labels through i18n. Tabs "
        "would stay English even after switching to zh-CN."
    )


def test_i18n_format_template_substitutes_placeholders():
    """Unit-test the formatTemplate behaviour by parsing the source.
    We assert the regex actually targets ``{name}`` placeholders so
    a future refactor doesn't accidentally drop that contract."""
    src = _read("lib/i18n/index.ts")
    assert re.search(
        r"replace\(\s*/\\\{\(\\w\+\)\\\}/g",
        src,
    ), (
        "formatTemplate's regex no longer matches {name} placeholders. "
        "All interpolating keys (email.recipients, palette.openMode, "
        "etc.) would render the literal {name} text."
    )
