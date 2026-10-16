"""Verify a locally prepared launch kit without extracting executable files."""

import argparse
import hashlib
import json
import pathlib
import plistlib
import stat
import zipfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def check_archive(archive):
    names = archive.namelist()
    if len(names) != len(set(names)) or len(names) > 10000:
        raise ValueError("Archive contains duplicate or excessive entries")
    for info in archive.infolist():
        path = pathlib.PurePosixPath(info.filename)
        if path.is_absolute() or ".." in path.parts or "\\" in info.filename or path.as_posix() != info.filename.rstrip('/'):
            raise ValueError(f"Unsafe archive path: {info.filename}")
        if stat.S_ISLNK(info.external_attr >> 16):
            raise ValueError(f"Unexpected symbolic link: {info.filename}")
    if sum(info.file_size for info in archive.infolist()) > 512 * 1024 * 1024:
        raise ValueError("Archive exceeds the launch-kit verification size limit")
    bad = archive.testzip()
    if bad:
        raise ValueError(f"Archive CRC failed: {bad}")


def verify(root, against_workspace=False):
    site = root / "website/dist"
    downloads = root / "release/github"
    if (site / "downloads").exists() or (site / "demo").exists():
        raise ValueError("The website must not host release downloads or the app demo")
    release = json.loads((site / "release.json").read_text())
    checksums = (downloads / "SHA256SUMS.txt").read_text().splitlines()
    for key, expected_name in [("mac", "wattle-notes-macos-arm64.zip"), ("source", "wattle-notes-source.zip")]:
        entry = release[key]
        if entry["name"] != expected_name:
            raise ValueError(f"Unexpected {key} archive name")
        data = (downloads / expected_name).read_bytes()
        if len(data) != entry["size"] or digest(data) != entry["sha256"]:
            raise ValueError(f"Download does not match release metadata: {expected_name}")
        if f"{entry['sha256']}  {expected_name}" not in checksums:
            raise ValueError(f"Download checksum file does not match: {expected_name}")

    with zipfile.ZipFile(downloads / release["mac"]["name"]) as archive:
        check_archive(archive)
        prefix = "Wattle Notes.app/Contents/"
        info = plistlib.loads(archive.read(prefix + "Info.plist"))
        if info["CFBundleShortVersionString"] != release["version"]:
            raise ValueError("Mac bundle and release versions differ")
        binary = archive.read(prefix + "MacOS/wattle-notes")
        if binary[:8] != bytes.fromhex("cffaedfe0c000001"):
            raise ValueError("The Mac archive is not the advertised Apple Silicon build")
        for name in ["LICENSE", "THIRD_PARTY_NOTICES.md"]:
            if not archive.read(prefix + "Resources/" + name):
                raise ValueError(f"Missing bundled notice: {name}")
        if against_workspace:
            built = root / "src-tauri/target/release/bundle/macos/Wattle Notes.app/Contents/MacOS/wattle-notes"
            if binary != built.read_bytes():
                raise ValueError("The download differs from the current native build")

    with zipfile.ZipFile(downloads / release["source"]["name"]) as archive:
        check_archive(archive)
        prefix = f"wattle-notes-{release['version']}-source/"
        manifest_name = prefix + "SOURCE-SHA256SUMS.txt"
        manifest = archive.read(manifest_name).decode().splitlines()
        expected_files = {manifest_name}
        for line in manifest:
            checksum, name = line.split("  ", 1)
            path = pathlib.PurePosixPath(name)
            if path.is_absolute() or ".." in path.parts or "\\" in name or name != path.as_posix():
                raise ValueError(f"Unsafe source manifest path: {name}")
            if prefix + name in expected_files:
                raise ValueError(f"Duplicate source manifest entry: {name}")
            expected_files.add(prefix + name)
            if digest(archive.read(prefix + name)) != checksum:
                raise ValueError(f"Source checksum failed: {name}")
            if against_workspace and digest((root / name).read_bytes()) != checksum:
                raise ValueError(f"Source archive is older than the workspace: {name}")
        actual_files = {entry.filename for entry in archive.infolist() if not entry.is_dir()}
        if actual_files != expected_files:
            raise ValueError("Source archive contains files outside its manifest")
        for path in actual_files:
            parts = pathlib.PurePosixPath(path).parts
            if any(part.startswith(".env") or part in {".notes", "node_modules", "target", "dist", "HANDOFF.md", "AGENTS.md", "CURRENT_STATE.md", ".git", "__pycache__"} for part in parts):
                raise ValueError(f"Private or generated source file included: {path}")
        for name in ["LICENSE", "THIRD_PARTY_NOTICES.md", "README.md", "package-lock.json", "src-tauri/Cargo.lock"]:
            archive.getinfo(prefix + name)

    kit = root / "release/wattle-notes-launch-kit.zip"
    expected, name = (root / "release/SHA256SUMS.txt").read_text().strip().split("  ", 1)
    if name != kit.name or digest(kit.read_bytes()) != expected:
        raise ValueError("The upload ZIP checksum does not match")
    with zipfile.ZipFile(kit) as archive:
        check_archive(archive)
        actual = {entry.filename for entry in archive.infolist() if not entry.is_dir()}
        expected = {path.relative_to(site).as_posix() for path in site.rglob("*") if path.is_file()}
        if actual != expected:
            raise ValueError("The upload ZIP is missing files or has extra entries")
        for name in actual:
            if archive.read(name) != (site / name).read_bytes():
                raise ValueError(f"Upload ZIP content differs from the site: {name}")
    print(f"Verified GitHub app/source assets, {len(manifest)} source checksums, notices, versions and static website ZIP.")
    print("These checks establish artifact consistency, not code signing, cloud acceptance or public hosting.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--against-workspace", action="store_true", help="Also compare the archive with current source and native binary")
    args = parser.parse_args()
    try:
        verify(pathlib.Path(__file__).resolve().parent.parent, args.against_workspace)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        parser.exit(1, f"Launch verification failed: {error}\n")
