import importlib.util
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location("reader", Path(__file__).with_name("Read-GuestReports.py"))
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


class ReportReaderTests(unittest.TestCase):
    def filesystem(self, bad=None, content=b'{}'):
        def get(path):
            return SimpleNamespace(
                attributes=SimpleNamespace(STANDARD_INFORMATION=[SimpleNamespace(file_attributes=0x400 if path == bad else 0)]),
                is_dir=lambda: path != r"GoodreadsVM\output\vm-last-run.json",
                open=lambda: BytesIO(content))
        return SimpleNamespace(mft=SimpleNamespace(get=get))

    def test_reads_only_known_reports_and_rejects_guest_links_at_every_component(self):
        self.assertEqual(reader.read_report(self.filesystem(), "vm-last-run.json"), b'{}')
        for component in ("GoodreadsVM", r"GoodreadsVM\output", r"GoodreadsVM\output\vm-last-run.json"):
            with self.subTest(component=component), self.assertRaisesRegex(ValueError, "reparse"):
                reader.read_report(self.filesystem(bad=component), "vm-last-run.json")
        with self.assertRaisesRegex(ValueError, "Unknown"):
            reader.read_report(self.filesystem(), r"..\secret.txt")
        with self.assertRaisesRegex(ValueError, "Oversized"):
            reader.read_report(self.filesystem(content=b'x' * (reader.MAXIMUM_BYTES + 1)), "vm-last-run.json")


if __name__ == "__main__":
    unittest.main()
