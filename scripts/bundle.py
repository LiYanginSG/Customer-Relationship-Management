#!/usr/bin/env python3
"""
Build paste-ready, single-file versions of each edge function.

Why this exists: deploying from the Supabase dashboard means pasting ONE file
into a browser editor. Our source is split across a dozen modules under
_shared/, which is right for reading and testing but cannot be pasted.

`deno bundle` would work but inlines the npm packages too, producing a 4.8MB
file no browser editor will accept. This inliner only flattens our own local
modules and leaves `npm:` and `jsr:` imports as imports, which is exactly what
the Supabase runtime wants.

Usage:  python3 scripts/bundle.py
Output: dist/telegram.ts, dist/briefing.ts
"""

import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FUNCTIONS = ROOT / "supabase" / "functions"
DIST = ROOT / "dist"

# Matches a whole import statement, including ones spanning several lines.
IMPORT_RE = re.compile(
    r'^import\s+(?P<clause>[\s\S]*?)\s*from\s*["\'](?P<spec>[^"\']+)["\'];?\s*$',
    re.MULTILINE,
)
# `import "./x.ts";` with no clause
BARE_IMPORT_RE = re.compile(r'^import\s*["\'](?P<spec>[^"\']+)["\'];?\s*$', re.MULTILINE)


def is_local(spec: str) -> bool:
    return spec.startswith("./") or spec.startswith("../")


def resolve(from_file: Path, spec: str) -> Path:
    return (from_file.parent / spec).resolve()


class Module:
    def __init__(self, path: Path):
        self.path = path
        self.source = path.read_text()
        self.deps: list[Path] = []
        self.external: list[str] = []   # full import statements to hoist
        self.namespace_aliases: list[str] = []
        self.body = self._process()

    def _process(self) -> str:
        body = self.source

        for match in list(IMPORT_RE.finditer(body)):
            clause = match.group("clause").strip()
            spec = match.group("spec")

            if is_local(spec):
                self.deps.append(resolve(self.path, spec))
                # `import * as T from "./tools.ts"` -- callers write T.foo, which
                # has to become plain foo once everything lives in one scope.
                ns = re.match(r'^\*\s+as\s+(\w+)$', clause)
                if ns:
                    self.namespace_aliases.append(ns.group(1))
                body = body.replace(match.group(0), "")
            else:
                self.external.append(match.group(0).strip())
                body = body.replace(match.group(0), "")

        for match in list(BARE_IMPORT_RE.finditer(body)):
            spec = match.group("spec")
            if is_local(spec):
                self.deps.append(resolve(self.path, spec))
            else:
                self.external.append(match.group(0).strip())
            body = body.replace(match.group(0), "")

        for alias in self.namespace_aliases:
            body = re.sub(rf'\b{re.escape(alias)}\.', '', body)

        return body.strip()


def collect(entry: Path, seen: dict[Path, Module]) -> None:
    if entry in seen:
        return
    module = Module(entry)
    seen[entry] = module
    for dep in module.deps:
        collect(dep, seen)


def topo_sort(entry: Path, modules: dict[Path, Module]) -> list[Path]:
    """Dependencies before dependents, so declarations precede their use."""
    order: list[Path] = []
    state: dict[Path, int] = {}

    def visit(path: Path) -> None:
        mark = state.get(path, 0)
        if mark == 2:
            return
        if mark == 1:
            # A cycle would mean a module using something not yet declared.
            # Our graph has none; fail loudly rather than emit broken output.
            raise SystemExit(f"Import cycle involving {path}")
        state[path] = 1
        for dep in modules[path].deps:
            visit(dep)
        state[path] = 2
        order.append(path)

    visit(entry)
    return order


def build(entry_rel: str, out_name: str) -> None:
    entry = (FUNCTIONS / entry_rel).resolve()
    modules: dict[Path, Module] = {}
    collect(entry, modules)
    order = topo_sort(entry, modules)

    externals: list[str] = []
    for path in order:
        for statement in modules[path].external:
            if statement not in externals:
                externals.append(statement)

    header = f"""// ---------------------------------------------------------------------------
// {out_name} -- generated file, do not edit directly.
//
// Built from supabase/functions/{entry_rel} and everything it imports, flattened
// into one file so it can be pasted straight into the Supabase dashboard's
// Edge Function editor. No terminal required.
//
// Edit the real source under supabase/functions/, then regenerate with:
//     python3 scripts/bundle.py
// ---------------------------------------------------------------------------

"""

    parts = [header, "\n".join(externals), "\n"]
    for path in order:
        rel = path.relative_to(FUNCTIONS)
        parts.append(f"\n// ===== {rel} " + "=" * max(0, 60 - len(str(rel))) + "\n")
        parts.append(modules[path].body)
        parts.append("\n")

    DIST.mkdir(exist_ok=True)
    out = DIST / out_name
    out.write_text("".join(parts))
    print(f"  {out.relative_to(ROOT)}  ({out.stat().st_size / 1024:.0f} KB, "
          f"{len(order)} modules)")


if __name__ == "__main__":
    print("Bundling edge functions for dashboard deployment:")
    build("telegram/index.ts", "telegram.ts")
    build("briefing/index.ts", "briefing.ts")
    print("\nPaste each file into Supabase -> Edge Functions -> Deploy a new function.")
