import io
import pathlib
import runpy
import stat
import unittest
import warnings
import zipfile

check_archive = runpy.run_path(str(pathlib.Path(__file__).resolve().parents[1] / "scripts/verify-launch.py"))["check_archive"]


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


if __name__ == "__main__":
    unittest.main()
