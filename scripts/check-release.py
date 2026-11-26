#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Check the working tree (or the exact Git index with --staged) before sharing."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import unicodedata

ROOT = Path(__file__).resolve().parents[1]
RULES = {
    "account number": r"(?<![a-z\d])\d{12}(?![a-z\d])",
    "home directory": r"/(?:users|home)/[\w.-]+|[a-z]:[\\/]users[\\/][^\\/\s]+",
    "private URL": r"(?:https?://|@)[^/\s@]+\.(?:internal|corp|local)(?:[:/\s]|$)|hooks\.[s]lack\.com/services/",
    "credential": r"(?:AKIA|ASIA)[A-Z\d]{16}|gh[pousr]_[A-Za-z0-9_]{22,}|github_pat_[\w]{28,}|xox[baprs]-[\w-]{14,}|sk-(?:proj-)?[\w-]{20,}|-----BEGIN [\w ]*PRIVATE KEY-----",
    "credential assignment": r"""(?:secret[_-]?access[_-]?key|api[_-]?key|password|access[_-]?token)\s*[:=]\s*["'][\w+/=.-]{12,}["']""",
}
PATTERNS = {name: re.compile(rule, re.I) for name, rule in RULES.items()}
IMAGES = {".png", ".gif", ".icns", ".svg", ".drawio"}
GALLERY_PDFS = {
    "examples/gallery/cognito-cimd/cognito-cimd.pdf": "2b0c5f917fbd7c181056fc899748008409cc6a470d2d0e8a1483e7f863fa8688",
    "examples/gallery/jev-guardrail/jev-guardrail.pdf": "c32c06184b389769a7269bf4b528c85145cc667ed324f9f47cc1fec0b17aec7e",
    "examples/gallery/rag-webinar/rag-webinar.pdf": "cc38edb5e36ec7e032803200682967d7a17a6843df4a9e8b12da4f7aa97f1119",
}
LICENSED_FONTS = {
    "marp/themes/assets/NotoSansJP-Book450.woff2": "ec4c61de6915ba9bb08324eaa98381600f041e1a93ea04c829be6ce0ac97149d",
    "marp/themes/assets/NotoSansJP-Bold.woff2": "ca0ddf5cbf6bc072e0202bf340091df7a4e743f1c76adf391a60afcd55708385",
    "marp/themes/assets/NotoSansJP-Regular.woff2": "5340b975a5b11d1279e9e3c6ddff3aa33167d653e42a255e0f2413a63f8b2322",
    "marp/themes/assets/NotoSansJP-OFL.txt": "1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9",
}
ARCHIVES = {".woff", ".woff2", ".ttf", ".otf", ".pdf", ".pptx", ".zip", ".tgz", ".key", ".pem", ".p12"}
ASSETS = "scripts/reviewed-images.json"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def load_terms(path):
    patterns = []
    for number, term in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        term = unicodedata.normalize("NFKC", term.strip())
        if not term:
            continue
        expression = term[3:] if term.startswith("re:") else re.escape(term)
        try:
            patterns.append(re.compile(expression, re.I))
        except re.error:
            raise ValueError(f"invalid dictionary pattern on line {number}") from None
    return patterns


def findings(text, extra):
    normalized = unicodedata.normalize("NFKC", text)
    labels = [label for label, pattern in PATTERNS.items() if pattern.search(normalized)]
    if any(pattern.search(normalized) for pattern in extra):
        labels.append("private review dictionary")
    return labels


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staged", action="store_true", help="scan all files in the index")
    parser.add_argument("--terms", type=Path, help="local UTF-8 dictionary, one literal or re:pattern per line")
    args = parser.parse_args()
    names = git("ls-files", "-z", "--cached", *([] if args.staged else ["--others", "--exclude-standard"]))
    files = sorted(set(os.fsdecode(n) for n in names.split(b"\0") if n))
    modes = {}
    if args.staged:
        for record in git("ls-files", "--stage", "-z").split(b"\0"):
            if record:
                metadata, name = record.split(b"\t", 1)
                modes[os.fsdecode(name)] = metadata.split()[0]
    default_terms = Path.home() / ".config/jinno-slide-kit/release-words.txt"
    terms_path = args.terms or default_terms
    try:
        extra = load_terms(terms_path) if args.terms or default_terms.exists() else []
    except (OSError, ValueError) as error:
        parser.error(str(error))

    def read(name):
        return git("show", ":" + name) if args.staged else (ROOT / name).read_bytes()
    images = json.loads(read(ASSETS))
    fonts = {name for name, expected in LICENSED_FONTS.items() if name in files and digest(read(name)) == expected}
    if len(fonts) != len(LICENSED_FONTS):
        print("Font files or their OFL notice differ from the reviewed distribution.")
        return True
    errors = 0
    total = 0
    for name in files:
        file = ROOT / name
        if not args.staged and not file.exists() and not file.is_symlink():
            continue
        total += 1
        symlink = modes.get(name) == b"120000" if args.staged else file.is_symlink()
        if symlink:
            print(f"{name}: symbolic link"); errors += 1; continue
        data = read(name)
        labels = findings(name, extra)
        reviewed_pdf = name in GALLERY_PDFS and digest(data) == GALLERY_PDFS[name]
        if file.suffix.lower() in IMAGES:
            if images.get(name) != digest(data):
                labels.append("image requires visual and provenance review")
        if file.suffix.lower() in ARCHIVES and name not in fonts and not reviewed_pdf:
            labels.append("unreviewed font, archive, document or key")
        if file.name.startswith(".env") or file.name in {".npmrc", ".pypirc", "id_rsa", "id_ed25519"}:
            labels.append("local configuration or credential file")
        try:
            value = data.decode("utf-8")
            labels.extend(findings(value, extra))
            if "\0" in value:
                labels.append("unexpected binary content")
        except UnicodeDecodeError:
            if name not in fonts and not reviewed_pdf and (name not in images or file.suffix.lower() not in IMAGES):
                labels.append("unexpected binary file")
        if labels:
            print(f"{name}: {', '.join(sorted(set(labels)))}"); errors += 1
    print(f"Checked {total} files, {errors} flagged.")
    return bool(errors)


if __name__ == "__main__":
    sys.exit(main())
