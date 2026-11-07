"""Public protocol fixtures retain decoder coverage without recording metadata."""
import json
from pathlib import Path

from state_protocol_v2 import decode_port

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "notify_frames.json"


def test_public_samples_do_not_contain_recording_metadata():
    data = json.loads(FIXTURE_PATH.read_text())
    assert data["provenance"]["synthetic"] is False
    assert "generated_at" not in data
    assert "capture_files" not in data["provenance"]
    assert len(data["frames"]) == 142
    assert len({frame["id"] for frame in data["frames"]}) == 142
    private_fields = {"source", "captured_at", "sniffer_clock_iso", "record_index",
                      "ts_us_raw", "capture_file"}
    for frame in data["frames"]:
        assert not private_fields.intersection(frame)
        assert frame["id"].startswith("sample")
        bytes.fromhex(frame["hex"])
        bytes.fromhex(frame["plaintext_hex"])


def test_anonymous_samples_preserve_recorded_decoder_expectations():
    frames = json.loads(FIXTURE_PATH.read_text())["frames"]
    port_frames = [frame for frame in frames if "decoded_port" in frame]
    assert len(port_frames) == 89
    for frame in port_frames:
        assert decode_port(frame["decoded"]["piid"],
                           bytes.fromhex(frame["plaintext_hex"])) == frame["decoded_port"]


def test_fixture_export_omits_private_capture_metadata(tmp_path):
    from datetime import datetime, timezone
    from scripts.extract_btsnoop_frames import Frame, KIND_INLINE, build_fixture_doc

    first_capture = tmp_path / "private-owner-capture.log"
    second_capture = tmp_path / "another-private-capture.log"
    first_capture.write_text("local input")
    sample = json.loads(FIXTURE_PATH.read_text())["frames"][0]

    def frame(source, relative):
        return Frame(source=str(source), ts=datetime(2037, 2, 3, tzinfo=timezone.utc),
                     ts_us=123456789012345, t_rel_ms=relative, record_index=987654,
                     att_handle=0x001c, kind=KIND_INLINE,
                     payload=bytes.fromhex(sample["hex"]),
                     plaintext=bytes.fromhex(sample["plaintext_hex"]),
                     notes="private-owner-capture.log from recording host")

    frames = [frame(first_capture, 0), frame(first_capture, 200),
              frame(second_capture, 0)]
    exported = build_fixture_doc(frames, [first_capture, second_capture])
    serialized = json.dumps(exported)
    for private in [str(tmp_path), "private-owner", "another-private", "2037-02-03",
                    "123456789012345", "987654", "recording host"]:
        assert private not in serialized
    assert exported["provenance"]["synthetic"] is False
    assert "generated_at" not in exported
    assert [f["id"] for f in exported["frames"]] == [
        "sample1-0001", "sample1-0002", "sample2-0001"]
    assert [f["t_rel_ms"] for f in exported["frames"]] == [0, 200, 0]
    for result, original in zip(exported["frames"], frames):
        assert result["hex"] == original.payload.hex()
        assert result["plaintext_hex"] == original.plaintext.hex()
        assert result["decoded_port"] == sample["decoded_port"]
        assert not {"source", "captured_at", "sniffer_clock_iso", "record_index",
                    "ts_us_raw", "capture_file"}.intersection(result)
    first_capture.unlink()
    assert build_fixture_doc(frames, []) == exported
