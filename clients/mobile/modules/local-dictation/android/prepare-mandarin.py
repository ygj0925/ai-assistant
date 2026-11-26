"""Verify and stage manually obtained Android Mandarin dictation assets."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import tarfile
import zipfile


def verify(file, expected):
    with file.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != expected:
            raise ValueError(f"Unexpected checksum for {file.name}.")


def stage(args):
    manifest = json.loads(Path(__file__).with_name("mandarin-assets.json").read_text(encoding="utf-8"))
    verify(args.aar, manifest["aar"]["sha256"])
    verify(args.model, manifest["model"]["sha256"])
    output = args.output.resolve()
    repository = Path(__file__).resolve().parents[5]
    if output == repository or repository in output.parents:
        raise ValueError("Choose an asset directory outside the source checkout.")
    if output.exists():
        raise ValueError("Choose a new asset directory.")

    with zipfile.ZipFile(args.aar) as aar, tarfile.open(args.model, "r:bz2") as model:
        members = {PurePosixPath(member.name).name: member for member in model.getmembers() if member.isfile()}
        for filename, proof in manifest["files"].items():
            if filename.startswith("assets/"):
                member = members[PurePosixPath(filename).name]
                if member.size != proof["bytes"]:
                    raise ValueError(f"Unexpected asset size for {filename}.")
                content = model.extractfile(member).read()
            else:
                member = aar.getinfo(filename)
                if member.file_size != proof["bytes"]:
                    raise ValueError(f"Unexpected runtime size for {filename}.")
                content = aar.read(member)
            if hashlib.sha256(content).hexdigest() != proof["sha256"]:
                raise ValueError(f"Unexpected checksum for {filename}.")
            target = output / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as stream:
                stream.write(content)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--aar", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    stage(parser.parse_args())
