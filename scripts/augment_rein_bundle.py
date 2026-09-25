from __future__ import annotations
import argparse,hashlib,json,shutil,tarfile,tempfile
from pathlib import Path

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def main():
 p=argparse.ArgumentParser();p.add_argument("--base",required=True);p.add_argument("--models",required=True);p.add_argument("--version",required=True);p.add_argument("--output",required=True);p.add_argument("--manifest",required=True);a=p.parse_args()
 with tempfile.TemporaryDirectory() as td:
  root=Path(td)
  with tarfile.open(a.base,"r:gz") as t:t.extractall(root,filter="data")
  dirs=[x for x in root.iterdir() if x.is_dir()]
  if len(dirs)!=1:raise RuntimeError("Unexpected base bundle")
  old=dirs[0];new=root/a.version;old.rename(new)
  dst=new/"market_models";dst.mkdir()
  src=Path(a.models)
  for role in ("first","second","third"):
   shutil.copy2(src/role/"real_odds_market.txt",dst/f"{role}_market.txt")
   shutil.copy2(src/role/"real_odds_without_people.txt",dst/f"{role}_rein.txt")
  internal=json.loads((new/"manifest.json").read_text())
  internal["version"]=a.version
  files=[]
  for path in sorted(new.rglob("*")):
   if path.is_file() and path.name!="manifest.json":
    rel=path.relative_to(new).as_posix();files.append({"path":rel,"sha256":sha(path),"size_bytes":path.stat().st_size})
  internal["files"]=files;(new/"manifest.json").write_text(json.dumps(internal,ensure_ascii=False,indent=2))
  out=Path(a.output);out.parent.mkdir(parents=True,exist_ok=True)
  with tarfile.open(out,"w:gz") as t:t.add(new,arcname=a.version)
  external={k:internal[k] for k in ("schema_version","version","model_family","roles","feature_count","trained_through","history_from","history_through","history_rows","history_races") if k in internal}
  external["source_commit"]=a.version.removeprefix("rein-role-v4-")
  external["files"]=files
  Path(a.manifest).write_text(json.dumps(external,ensure_ascii=False,indent=2))
  print(json.dumps({"version":a.version,"bundle_sha256":sha(out),"files":len(files)}))
if __name__=="__main__":main()
