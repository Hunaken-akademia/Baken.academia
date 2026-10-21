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


def test_navigation_does_not_collect_unrelated_attachments_or_text():
    raw = '''<html><main><nav>砂厚 <a href="/other.pdf">広告</a></nav>
    <a href="/news/condition-260905">走路状況</a><a href="/race.pdf">出走表</a>
    <p>含水率3~5%を目標に管理</p></main></html>'''.encode()
    _, text, links = extract_html(raw, "https://official.example/", {"official.example"})
    assert "広告" not in text
    assert len(links) == 1
    assert "目標" in text  # retained as text, never converted to a measurement
