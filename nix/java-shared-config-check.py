#!/usr/bin/env python3
"""Drift guard for the shared Java build config duplicated across the two de-reactored
units (task 517). With no root pom/pluginManagement to inherit from, the
maven-compiler-plugin <compilerArgs> (Error Prone / NullAway flags) and the spotless /
pmd / checkstyle plugin blocks are spelled out in BOTH
packages/java/connect-unary-adapter/pom.xml and services/business-logic-java/pom.xml.
They are byte-equivalent today; this check keeps them so.

It parses each pom (ElementTree drops XML comments, so differing prose around the
blocks is ignored — only structure/config/${property} placeholders are compared),
canonicalizes the four shared blocks, and diffs adapter-vs-service. Any mismatch fails
the build with a unified diff. Wired as checks.java-shared-build-config-sync (runs in
`nix flake check`). Mirrors nix/lefthook.nix's lefthook-config-sync drift guard.
"""

import difflib
import sys
import xml.etree.ElementTree as ET

NS = "{http://maven.apache.org/POM/4.0.0}"


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def canon(el: ET.Element, depth: int = 0) -> str:
    """Whitespace-normalized, comment-free serialization of an element subtree.

    Indentation-only text/tail is stripped, attributes are sorted, so two elements
    that differ only in surrounding formatting or comments canonicalize identically.
    """
    pad = "  " * depth
    attrs = " ".join(f'{local(k)}="{v}"' for k, v in sorted(el.attrib.items()))
    head = f"{pad}<{local(el.tag)}" + (f" {attrs}" if attrs else "") + ">"
    text = (el.text or "").strip()
    if text:
        head += text
    lines = [head]
    for child in el:
        lines.append(canon(child, depth + 1))
    lines.append(f"{pad}</{local(el.tag)}>")
    return "\n".join(lines)


def find_plugin(root: ET.Element, artifact_id: str) -> ET.Element:
    for plugin in root.iter(f"{NS}plugin"):
        aid = plugin.find(f"{NS}artifactId")
        if aid is not None and aid.text == artifact_id:
            return plugin
    raise SystemExit(f"drift-guard: plugin '{artifact_id}' not found in a pom")


def blocks(pom_path: str) -> dict[str, str]:
    root = ET.parse(pom_path).getroot()
    compiler = find_plugin(root, "maven-compiler-plugin")
    args = compiler.find(f".//{NS}compilerArgs")
    if args is None:
        raise SystemExit(f"drift-guard: no <compilerArgs> in {pom_path}")
    return {
        "compilerArgs": canon(args),
        "spotless-maven-plugin": canon(find_plugin(root, "spotless-maven-plugin")),
        "maven-pmd-plugin": canon(find_plugin(root, "maven-pmd-plugin")),
        "maven-checkstyle-plugin": canon(find_plugin(root, "maven-checkstyle-plugin")),
    }


def main() -> int:
    adapter_pom, service_pom = sys.argv[1], sys.argv[2]
    adapter, service = blocks(adapter_pom), blocks(service_pom)

    failed = False
    for name in adapter:
        a, s = adapter[name], service[name]
        if a != s:
            failed = True
            print(f"\n=== DRIFT in shared block '{name}' ===", file=sys.stderr)
            diff = difflib.unified_diff(
                a.splitlines(),
                s.splitlines(),
                fromfile=f"connect-unary-adapter:{name}",
                tofile=f"business-logic-java:{name}",
                lineterm="",
            )
            print("\n".join(diff), file=sys.stderr)

    if failed:
        print(
            "\nERROR: shared Java build config drifted between the two units.\n"
            "The <compilerArgs> + spotless/pmd/checkstyle blocks must stay identical\n"
            "in packages/java/connect-unary-adapter/pom.xml and\n"
            "services/business-logic-java/pom.xml (task 517).",
            file=sys.stderr,
        )
        return 1

    print("java-shared-build-config-sync: OK (4 shared blocks identical across both units)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
