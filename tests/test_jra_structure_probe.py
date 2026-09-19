from baken_academia.jra_structure_probe import summarize_tables


def test_summarize_tables_keeps_classes_and_text_without_raw_html():
    payload = """
    <div id="race_result_1">
      <table class="pay"><tr><th class="type">単勝</th><td class="number">3</td><td class="yen">520円</td></tr></table>
    </div>
    """.encode("cp932")
    result = summarize_tables(payload)
    assert result[0]["unit_id"] == "race_result_1"
    assert result[0]["tables"][0]["class"] == "pay"
    assert result[0]["tables"][0]["rows"][0][0]["text"] == "単勝"
