from scripts.collect_track_reference import allowed, extract_html


def test_only_https_official_hosts_are_allowed():
    hosts = {"official.example"}
    assert allowed("https://official.example/news/a", hosts)
    assert not allowed("https://official.example.evil.test/a", hosts)
    assert not allowed("http://official.example/a", hosts)
    assert not allowed("https://user@official.example/a", hosts)


def test_article_preserves_pdf_image_and_japanese_without_charset():
    raw = '''<html><title>砂厚測定</title><main><p>2026年10月20日 砂厚測定</p>
    <a href="/table.pdf">測定表</a><img src="/resources/images/news/table.png">
    <a href="https://advert.example/x.pdf">砂厚</a></main></html>'''.encode()
    title, text, links = extract_html(raw, "https://official.example/news/a", {"official.example"}, True)
    assert title == "砂厚測定"
    assert "2026年10月20日" in text
    assert {r["url"] for r in links} == {"https://official.example/table.pdf", "https://official.example/resources/images/news/table.png"}


def test_shift_jis_fragment_retains_venue_and_measurement_time():
    raw = '<div title="東京"><div>10月18日（日曜）7時00分</div><div>9.2</div></div>'.encode("cp932")
    _, text, _ = extract_html(raw, "https://official.example/data", {"official.example"})
    assert "10月18日(日曜)7時00分" in text
    assert "�" not in text


def test_navigation_does_not_collect_unrelated_attachments_or_text():
    raw = '''<html><main><nav>砂厚 <a href="/other.pdf">広告</a></nav>
    <a href="/news/condition-260905">走路状況</a><a href="/race.pdf">出走表</a>
    <p>含水率3~5%を目標に管理</p></main></html>'''.encode()
    _, text, links = extract_html(raw, "https://official.example/", {"official.example"})
    assert "広告" not in text
    assert len(links) == 1
    assert "目標" in text  # retained as text, never converted to a measurement


def test_error_pages_are_not_successful_documents_and_host_is_paused(tmp_path, monkeypatch):
    import json
    from pathlib import Path
    from types import SimpleNamespace
    from scripts.collect_track_reference import collect

    calls = []

    def fetch(command, **kwargs):
        url = command[-1]
        calls.append(url)
        Path(command[command.index("--output") + 1]).write_bytes(b"<title>404 Not Found</title>")
        status = 403 if "/blocked" in url else 200
        return SimpleNamespace(returncode=0, stdout=f"{status}\n{url}")

    monkeypatch.setattr("scripts.collect_track_reference.subprocess.run", fetch)
    sources = [{"venue": "test", "url": f"https://official.example/{p}"} for p in ["missing", "blocked", "later"]]
    rows = collect({"allowed_hosts": ["official.example"], "sources": sources}, tmp_path, interval=0)
    assert [r["status"] for r in rows] == ["error", "error", "host-paused"]
    assert len(calls) == 2
    assert json.loads((tmp_path / "manifest.json").read_text())["counts"] == {"error": 2, "host-paused": 1}
