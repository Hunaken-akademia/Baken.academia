"""Copy data/pedigree.json out of the active REIN model bundle (read only)."""
import hashlib, io, sys, tarfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from refresh_rein_history import broker, open_with_retry  # noqa: E402

def main(output: str):
    active = broker({'action': 'current'})
    with open_with_retry(active['bundle_url'], timeout=60) as r:
        bundle = r.read()
    if hashlib.sha256(bundle).hexdigest() != active['model']['artifact_sha256']:
        raise ValueError('Active bundle checksum mismatch')
    with tarfile.open(fileobj=io.BytesIO(bundle), mode='r:gz') as t:
        member = next(m for m in t.getmembers() if m.isfile() and m.name.endswith('/data/pedigree.json'))
        Path(output).write_bytes(t.extractfile(member).read())
    print('pedigree from', active['model']['version'], flush=True)

if __name__ == '__main__':
    main(sys.argv[1])
