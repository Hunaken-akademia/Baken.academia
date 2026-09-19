from baken_academia.jra_structure_probe import summarize_result_links, summarize_tables


def test_summarize_tables_keeps_classes_and_text_without_raw_html():
    payload = """
    <div id="race_result_1">
      <table class="pay"><tr><th class="type">単勝</th><td class="number">3</td><td class="yen">520円</td></tr></table>
    </div>
    """.encode("cp932")
    result = summarize_tables(payload)
    assert result[0]["owner_id"] == "race_result_1"
    assert result[0]["class"] == "pay"
    assert result[0]["rows"][0][0]["text"] == "単勝"


def test_summarize_result_links_keeps_official_action_without_raw_page():
    payload = """
    <div id="race_result_1">
      <a onclick="doAction('/JRADB/accessS.html','pw01sde0101202601010120260913/AA')">払戻金</a>
    </div>
    """.encode("cp932")
    result = summarize_result_links(payload)
    assert result == [
        {
            "owner_id": "race_result_1",
            "tag": "a",
            "text": "払戻金",
            "href": "",
            "onclick": "doAction('/JRADB/accessS.html','pw01sde0101202601010120260913/AA')",
        }
    ]
