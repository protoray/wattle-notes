import io
import hashlib
import json
import pathlib
import plistlib
import runpy
import platform
import stat
import subprocess
import sys
import tempfile
import unittest
import warnings
import zipfile

verifier = runpy.run_path(str(pathlib.Path(__file__).resolve().parents[1] / "scripts/verify-launch.py"))
check_archive = verifier["check_archive"]


class LaunchArchiveTests(unittest.TestCase):
    def archive(self, entries):
        stream = io.BytesIO()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(stream, "w") as archive:
                for name, data in entries:
                    archive.writestr(name, data)
        stream.seek(0)
        return zipfile.ZipFile(stream)

    def test_regular_nested_files_are_accepted(self):
        with self.archive([("source/src/App.tsx", b"synthetic code")]) as archive:
            check_archive(archive)

    def test_traversal_absolute_and_aliased_paths_are_rejected(self):
        for name in ["../outside", "/outside", "source/../../outside", "source\\outside", "source//aliased", "source/./aliased"]:
            with self.subTest(name=name), self.archive([(name, b"synthetic")]) as archive:
                with self.assertRaises(ValueError):
                    check_archive(archive)

    def test_duplicate_file_entries_are_rejected(self):
        with self.archive([("file", b"first"), ("file", b"second")]) as archive:
            with self.assertRaises(ValueError):
                check_archive(archive)

    def test_symbolic_links_are_rejected_without_extraction(self):
        link = zipfile.ZipInfo("source/link")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with self.archive([(link, b"../../outside")]) as archive:
            with self.assertRaises(ValueError):
                check_archive(archive)

    def prepare_release(self, root, extra_source=None):
        downloads = root / "release/github"
        downloads.mkdir(parents=True)
        version = "9.8.7"
        with zipfile.ZipFile(downloads / "wattle-notes-macos-arm64.zip", "w") as archive:
            prefix = "Wattle Notes.app/Contents/"
            archive.writestr(prefix + "Info.plist", plistlib.dumps({"CFBundleShortVersionString": version}))
            archive.writestr(prefix + "MacOS/wattle-notes", bytes.fromhex("cffaedfe0c000001") + b"synthetic binary")
            for name in ["LICENSE", "THIRD_PARTY_NOTICES.md"]:
                archive.writestr(prefix + "Resources/" + name, b"synthetic notice")
        sources = {name: b"synthetic source" for name in ["LICENSE", "THIRD_PARTY_NOTICES.md", "README.md", "package-lock.json", "src-tauri/Cargo.lock"]}
        sources.update(extra_source or {})
        with zipfile.ZipFile(downloads / "wattle-notes-source.zip", "w") as archive:
            prefix = f"wattle-notes-{version}-source/"
            manifest = []
            for name, data in sources.items():
                archive.writestr(prefix + name, data)
                manifest.append(f"{hashlib.sha256(data).hexdigest()}  {name}")
            archive.writestr(prefix + "SOURCE-SHA256SUMS.txt", "\n".join(manifest) + "\n")
        release = {"version": version}
        sums = []
        for key, name in [("mac", "wattle-notes-macos-arm64.zip"), ("source", "wattle-notes-source.zip")]:
            data = (downloads / name).read_bytes()
            checksum = hashlib.sha256(data).hexdigest()
            release[key] = {"name": name, "size": len(data), "sha256": checksum}
            sums.append(f"{checksum}  {name}")
        (downloads / "release.json").write_text(json.dumps(release))
        (downloads / "SHA256SUMS.txt").write_text("\n".join(sums) + "\n")

    def test_app_release_verifies_without_a_website_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            self.prepare_release(root)
            verifier["verify"](root)
            self.assertFalse((root / "website").exists())

    def test_valid_checksums_do_not_allow_private_website_files_in_source(self):
        for name in ["website/index.html", "website/launch.json", "playwright.site.config.ts", "playwright.capture.config.ts", "tests/website/launch.spec.ts", "tests/capture/website.spec.ts", "AGENTS.md", "docs/CURRENT_STATE.md"]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as folder:
                root = pathlib.Path(folder)
                self.prepare_release(root, {name: b"private fixture"})
                with self.assertRaisesRegex(ValueError, "Private, website or generated"):
                    verifier["verify"](root)

    def mac_fixture(self, root, sign=True, tamper=False):
        self.prepare_release(root)
        app = root / "fixture/Wattle Notes.app"
        contents = app / "Contents"
        (contents / "MacOS").mkdir(parents=True)
        (contents / "Resources").mkdir()
        subprocess.run(["/usr/bin/clang", "-arch", "arm64", "-x", "c", "-", "-o", str(contents / "MacOS/wattle-notes")], input=b"int main(void) { return 0; }\n", check=True, capture_output=True)
        (contents / "Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": "org.wattlenotes.signature-fixture",
            "CFBundleExecutable": "wattle-notes",
            "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": "9.8.7",
        }))
        for name in ["LICENSE", "THIRD_PARTY_NOTICES.md"]:
            (contents / "Resources" / name).write_text("synthetic notice")
        if sign:
            subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", str(app)], check=True, capture_output=True)
        if tamper:
            (contents / "Resources/LICENSE").write_text("changed after signing")
        downloads = root / "release/github"
        mac = downloads / "wattle-notes-macos-arm64.zip"
        mac.unlink()
        subprocess.run(["/usr/bin/ditto", "-c", "-k", "--keepParent", "--norsrc", str(app), str(mac)], check=True)
        release = json.loads((downloads / "release.json").read_text())
        release["mac"].update(size=mac.stat().st_size, sha256=hashlib.sha256(mac.read_bytes()).hexdigest())
        (downloads / "release.json").write_text(json.dumps(release))
        (downloads / "SHA256SUMS.txt").write_text("".join(f"{release[key]['sha256']}  {release[key]['name']}\n" for key in ["mac", "source"]))

    @unittest.skipUnless(sys.platform == "darwin" and platform.machine() == "arm64", "Apple Silicon bundle check")
    def test_adhoc_signed_archive_passes_native_signature_check(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            self.mac_fixture(root)
            verifier["verify"](root, macos_signature=True)

    @unittest.skipUnless(sys.platform == "darwin" and platform.machine() == "arm64", "Apple Silicon bundle check")
    def test_executable_only_signature_does_not_replace_bundle_seal(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            self.mac_fixture(root, sign=False)
            with self.assertRaisesRegex(ValueError, "bundle resource seal"):
                verifier["verify"](root, macos_signature=True)

    @unittest.skipUnless(sys.platform == "darwin" and platform.machine() == "arm64", "Apple Silicon bundle check")
    def test_changed_resource_is_rejected_even_with_matching_archive_checksums(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            self.mac_fixture(root, tamper=True)
            with self.assertRaisesRegex(ValueError, "bundle signature verification failed"):
                verifier["verify"](root, macos_signature=True)


if __name__ == "__main__":
    unittest.main()
