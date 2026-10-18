"""Verify app/source release assets without extracting executable files."""

import argparse
import hashlib
import json
import pathlib
import plistlib
import stat
import subprocess
import sys
import tempfile
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


def check_source_path(name):
    path = pathlib.PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name or name != path.as_posix():
        raise ValueError(f"Unsafe source manifest path: {name}")
    private = {".notes", "node_modules", "target", "dist", "release", "HANDOFF.md", "AGENTS.md", "CURRENT_STATE.md", ".git", "__pycache__", "website", "playwright.capture.config.ts", "playwright.site.config.ts"}
    if (any(part.startswith(".env") or part in private for part in path.parts)
            or (len(path.parts) > 1 and path.parts[0] == "tests" and path.parts[1] in {"capture", "website"})
            or name.lower().endswith((".pem", ".key", ".p12", ".pfx", ".local.json"))):
        raise ValueError(f"Private, website or generated source file included: {name}")


def verify_macos_bundle(archive):
    # Paths/links/size were checked before extraction. Verify the actual ZIP,
    # including its resource seal, rather than only the build-directory binary.
    with tempfile.TemporaryDirectory(prefix="wattle-signature-check-") as folder:
        archive.extractall(folder)
        app = pathlib.Path(folder) / "Wattle Notes.app"
        seal = app / "Contents/_CodeSignature/CodeResources"
        if not seal.is_file() or seal.is_symlink():
            raise ValueError("Mac archive has no bundle resource seal")
        binary = app / "Contents/MacOS/wattle-notes"
        mode = archive.getinfo("Wattle Notes.app/Contents/MacOS/wattle-notes").external_attr >> 16
        if mode & 0o111 == 0:
            raise ValueError("Mac archive executable permissions are missing")
        binary.chmod(mode & 0o777)
        result = subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)], capture_output=True, text=True)
        if result.returncode:
            raise ValueError("Mac archive bundle signature verification failed")


def verify(root, against_workspace=False, macos_signature=False):
    downloads = root / "release/github"
    release = json.loads((downloads / "release.json").read_text())
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
        if macos_signature:
            verify_macos_bundle(archive)
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
            check_source_path(name)
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
            check_source_path(path[len(prefix):])
        for name in ["LICENSE", "THIRD_PARTY_NOTICES.md", "README.md", "package-lock.json", "src-tauri/Cargo.lock"]:
            archive.getinfo(prefix + name)

    print(f"Verified GitHub app/source assets, {len(manifest)} source checksums, notices and versions; website excluded.")
    if macos_signature:
        print("Extracted Mac ZIP bundle signature and sealed resources verified.")
    print("These checks do not establish Apple notarization, cloud acceptance or public hosting.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--against-workspace", action="store_true", help="Also compare the archive with current source and native binary")
    args = parser.parse_args()
    try:
        verify(pathlib.Path(__file__).resolve().parent.parent, args.against_workspace, macos_signature=sys.platform == "darwin")
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        parser.exit(1, f"Launch verification failed: {error}\n")
