#!/usr/bin/env python3
"""
assemble.py - consolidate scraped OpenCode docs into two navigable Markdown files.

Deterministic and re-runnable: re-scrape into ./v2 (*.md) and ./v1 (*.mdx), then
run `python3 assemble.py`. Output is byte-identical for identical inputs.

Inputs
    v2/*.md    scraped from https://opencode.ai/v2/docs      (Accept: text/markdown)
    v1/*.mdx   scraped from anomalyco/opencode packages/web/src/content/docs (English)

Outputs
    OPENCODE_V2_DOCS_FULL.md
    OPENCODE_V1_DOCS_FULL.md

Page content is copied verbatim (never edited); only scaffolding (header, TOC,
page delimiters) is generated. Pages under MIN_BYTES are dropped and listed in a
"Dropped pages" section.
"""

from __future__ import annotations

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
V2_DIR = os.path.join(HERE, "v2")
V1_DIR = os.path.join(HERE, "v1")
OUT_V2 = os.path.join(HERE, "OPENCODE_V2_DOCS_FULL.md")
OUT_V1 = os.path.join(HERE, "OPENCODE_V1_DOCS_FULL.md")

SCRAPE_DATE = "2026-09-25"
MIN_BYTES = 200
SEP = "=" * 80

V2_SOURCE_ROOT = "https://opencode.ai/v2/docs"
V1_SOURCE_ROOT = "https://opencode.ai/docs"

GENERATOR = "docs-scrape/assemble.py"

# Uppercase tokens used as-is when humanizing URL slugs.
ACRONYMS = {
    "acp": "ACP",
    "api": "API",
    "byok": "BYOK",
    "cli": "CLI",
    "mcp": "MCP",
    "rpc": "RPC",
    "sdk": "SDK",
    "tui": "TUI",
    "ui": "UI",
    "url": "URL",
    "wsl": "WSL",
}


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def list_files(directory: str, ext: str) -> list[str]:
    """Sorted basenames ending in `ext` (dotfiles included, unlike glob)."""
    return sorted(
        name
        for name in os.listdir(directory)
        if name.endswith(ext) and os.path.isfile(os.path.join(directory, name))
    )


def read_bytes(path: str) -> int:
    return os.path.getsize(path)


def humanize_word(word: str) -> str:
    if word in ACRONYMS:
        return ACRONYMS[word]
    return word.capitalize()


def humanize(segment: str) -> str:
    return " ".join(humanize_word(word) for word in segment.split("-"))


def title_from_slug(slug: str) -> str:
    """`cli/config` -> `CLI / Config`; empty slug -> `Intro`."""
    if not slug:
        return "Intro"
    return " / ".join(humanize(part) for part in slug.split("/"))


def slug_of(filename: str, ext: str) -> str:
    """`cli_config.md` -> `cli/config`; `.md` -> `` (docs root); `index.mdx` -> ``."""
    if not filename.endswith(ext):
        raise ValueError(f"{filename}: expected extension {ext}")
    base = filename[: -len(ext)] if len(filename) > len(ext) else ""
    slug = base.replace("_", "/")
    return "" if slug == "index" else slug


def html_pointer_note(filename: str, size: int) -> str:
    """Deterministic replacement body for pages scraped as raw HTML."""
    return (
        f"> **[assembler note]** `{filename}` was scraped as raw HTML "
        f"({size:,} bytes of client-rendered markup with no static text "
        "payload). The machine-readable API contract is cached alongside this "
        "file at `research/docs-scrape/v2/openapi.json`, and a distilled "
        "endpoint index lives at `research/api-types/API_SURFACE_REFERENCE.md` "
        "(section 8). This stub replaces the raw HTML to keep the consolidated "
        "file greppable and context-cheap; the untouched source remains at "
        f"`research/docs-scrape/v2/{filename}`.\n"
    )


def frontmatter(text: str) -> dict[str, str]:
    match = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n?", text, re.S)
    if not match:
        return {}
    fields: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            fields[key.strip()] = value
    return fields


def file_title(path: str, ext: str, slug: str) -> str:
    """v1: frontmatter title. v2: derived from the URL slug (no frontmatter)."""
    if ext == ".mdx":
        with open(path, encoding="utf-8") as handle:
            title = frontmatter(handle.read()).get("title")
        if title:
            return title
    return title_from_slug(slug)


# --------------------------------------------------------------------------- #
# ordering
# --------------------------------------------------------------------------- #
V2_GROUPS = [
    ("Intro", lambda s: s == ""),
    ("Config", lambda s: s == "config"),
    ("Migrate", lambda s: s == "migrate-v1"),
    ("Troubleshooting", lambda s: s == "troubleshooting"),
    ("Configure", lambda s: not s.startswith(("cli", "build", "console")) and s != "api"),
    ("CLI", lambda s: s.startswith("cli")),
    ("Build", lambda s: s.startswith("build")),
    ("API", lambda s: s == "api"),
    ("Console", lambda s: s.startswith("console")),
]


def v2_group(slug: str) -> int:
    for index, (_, predicate) in enumerate(V2_GROUPS):
        if predicate(slug):
            return index
    raise AssertionError(f"unrouted slug: {slug!r}")


def v2_url(slug: str) -> str:
    if not slug:
        return V2_SOURCE_ROOT + "/"
    return f"{V2_SOURCE_ROOT}/{slug}/"


def v1_url(slug: str) -> str:
    if slug == "index":
        return V1_SOURCE_ROOT + "/"
    return f"{V1_SOURCE_ROOT}/{slug}"


# --------------------------------------------------------------------------- #
# assembly
# --------------------------------------------------------------------------- #
def collect(directory: str, ext: str) -> list[dict]:
    pages = []
    for name in list_files(directory, ext):
        path = os.path.join(directory, name)
        slug = slug_of(name, ext)
        with open(path, encoding="utf-8", errors="replace") as handle:
            content = handle.read()
        size = read_bytes(path)
        # Some endpoints (e.g. the V2 API reference) are client-rendered apps:
        # the scrape yields raw HTML with no static text payload. Embedding
        # megabytes of markup would wreck greppability and waste context, so
        # replace such bodies with a deterministic pointer stub.
        html_stub = content.lstrip().startswith(("<!DOCTYPE", "<html"))
        if html_stub:
            content = html_pointer_note(name, size)
        pages.append(
            {
                "file": name,
                "path": path,
                "slug": slug,
                "bytes": size,
                "title": file_title(path, ext, slug),
                "content": content,
                "html_stub": html_stub,
            }
        )
    return pages


def order_v2(pages: list[dict]) -> list[dict]:
    return sorted(pages, key=lambda p: (v2_group(p["slug"]), p["slug"]))


def order_v1(pages: list[dict]) -> list[dict]:
    return sorted(
        pages,
        key=lambda p: (0 if p["slug"] == "" else 1, p["slug"]),
    )


def render(
    pages: list[dict],
    *,
    title: str,
    source_root: str,
    source_note: str,
    notes: list[str],
    url_of,
    group_of=None,
) -> tuple[str, list[dict], list[dict]]:
    kept = [p for p in pages if p["bytes"] >= MIN_BYTES]
    dropped = [p for p in pages if p["bytes"] < MIN_BYTES]

    total_bytes = sum(p["bytes"] for p in pages)
    kept_bytes = sum(p["bytes"] for p in kept)
    dropped_bytes = total_bytes - kept_bytes

    lines: list[str] = []
    lines.append(f"# {title}")
    lines.append("")
    lines.append(f"- **Scrape date:** {SCRAPE_DATE}")
    lines.append(f"- **Source root:** {source_root}")
    lines.append(f"- **Source:** {source_note}")
    lines.append(
        f"- **Pages:** {len(kept)} included / {len(pages)} scraped"
        + (f" / {len(dropped)} dropped" if dropped else "")
    )
    lines.append(
        f"- **Total bytes:** {total_bytes} source bytes "
        f"({kept_bytes} included, {dropped_bytes} dropped)"
    )
    lines.append(f"- **Generated by:** `{GENERATOR}` (deterministic; re-run after re-scraping)")
    for note in notes:
        lines.append(f"- **Note:** {note}")
    lines.append("")

    lines.append("## Table of contents")
    lines.append("")
    if group_of is None:
        for index, page in enumerate(kept, 1):
            lines.append(
                f"{index}. `{page['slug'] or '/'}` -> {page['title']}  "
                f"({url_of(page['slug'])})"
            )
    else:
        order: dict[int, list[dict]] = {}
        for page in kept:
            order.setdefault(group_of(page["slug"]), []).append(page)
        number = 1
        for group_index in sorted(order):
            group_name = (
                V2_GROUPS[group_index][0]
                if group_of is v2_group
                else str(group_index)
            )
            lines.append(f"### {group_name}")
            lines.append("")
            for page in order[group_index]:
                lines.append(
                    f"{number}. `{page['slug'] or '/'}` -> {page['title']}  "
                    f"({url_of(page['slug'])})"
                )
                number += 1
            lines.append("")
    lines.append("")

    for page in kept:
        lines.append(SEP)
        lines.append(f"## PAGE: {page['title']}  (source: {url_of(page['slug'])})")
        lines.append(SEP)
        lines.append("")
        content = page["content"]
        lines.append(content)
        if not content.endswith("\n"):
            lines.append("")
        lines.append("")

    if dropped:
        lines.append(SEP)
        lines.append("## Dropped pages")
        lines.append(SEP)
        lines.append("")
        lines.append(
            f"The following scraped files are under {MIN_BYTES} bytes and were not "
            "included above:"
        )
        lines.append("")
        for page in sorted(dropped, key=lambda p: p["file"]):
            lines.append(f"- `{page['file']}` (slug `{page['slug'] or '/'}`) - {page['bytes']} bytes")
        lines.append("")

    text = "\n".join(lines)
    if not text.endswith("\n"):
        text += "\n"
    return text, kept, dropped


def main() -> int:
    # ---------------- V2 ---------------- #
    v2_pages = order_v2(collect(V2_DIR, ".md"))
    stubbed = [p["file"] for p in v2_pages if p.get("html_stub")]
    stub_note = (
        "Scrapes that returned raw HTML (client-rendered pages) are replaced by "
        "pointer stubs in this file: "
        + (", ".join(f"`v2/{name}`" for name in stubbed) if stubbed else "none")
        + ". Consult `research/docs-scrape/v2/openapi.json` and "
        "`research/api-types/API_SURFACE_REFERENCE.md` for the API surface. "
        "Untouched HTML sources remain in `v2/`."
    )
    v2_notes = [
        "Ordering: Intro, Config, Migrate, Troubleshooting, then the Configure, "
        "CLI, Build, API and Console sections (alphabetical within each section).",
        stub_note,
        "Page titles are derived from URL slugs (`_` -> `/`) because V2 pages carry "
        "no frontmatter; non-HTML page bodies are copied byte-for-byte.",
    ]
    v2_text, v2_kept, v2_dropped = render(
        v2_pages,
        title="OpenCode V2 Docs - Full Reference (Consolidated)",
        source_root=V2_SOURCE_ROOT,
        source_note="opencode.ai/v2/docs, fetched with `Accept: text/markdown`",
        notes=v2_notes,
        url_of=v2_url,
        group_of=v2_group,
    )
    with open(OUT_V2, "w", encoding="utf-8") as handle:
        handle.write(v2_text)

    # ---------------- V1 ---------------- #
    v1_pages = order_v1(collect(V1_DIR, ".mdx"))
    v1_notes = [
        "These are **V1 docs kept for migration reference only**; the V2 docs "
        "(OPENCODE_V2_DOCS_FULL.md) are the source of truth.",
        "Content comes from `anomalyco/opencode` "
        "(`packages/web/src/content/docs/`), English pages only.",
        "Ordering: `index.mdx` first, then alphabetical by slug. Page titles come "
        "from each page's frontmatter; page bodies are copied byte-for-byte.",
    ]
    v1_text, v1_kept, v1_dropped = render(
        v1_pages,
        title="OpenCode V1 Docs - Full Reference (Consolidated, Migration Reference)",
        source_root=V1_SOURCE_ROOT,
        source_note="opencode.ai/docs (V1 site), content from the anomalyco/opencode repo",
        notes=v1_notes,
        url_of=v1_url,
    )
    with open(OUT_V1, "w", encoding="utf-8") as handle:
        handle.write(v1_text)

    # ---------------- report ---------------- #
    for label, path, kept, dropped in (
        ("V2", OUT_V2, v2_kept, v2_dropped),
        ("V1", OUT_V1, v1_kept, v1_dropped),
    ):
        print(
            f"{label}: {path} | {read_bytes(path)} bytes | "
            f"{len(kept)} pages | dropped: "
            + (", ".join(f"{p['file']} ({p['bytes']}B)" for p in dropped) or "none")
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
