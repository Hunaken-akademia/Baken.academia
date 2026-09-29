"""Conservative ranks from NAR's whole-field passing-order table.

Parenthesized horses are a group, not an asserted exact ordering. Keep their
positions unknown; count their slots to determine subsequent ungrouped ranks.
"""
import re
import unicodedata


def unambiguous_ranks(order):
    value = unicodedata.normalize("NFKC", order).replace(" ", "")
    atom = r"(?:\d+|\(\d+(?:,\d+)*\))"
    if not value or not re.fullmatch(rf"{atom}(?:[,=\-]+{atom})*", value):
        return {}
    tokens = re.findall(r"\([^()]*\)|\d+", value)
    horses, output = [], {}
    for token in tokens:
        ids = [int(n) for n in re.findall(r"\d+", token)]
        if not token.startswith("(") and len(ids) == 1:
            output[ids[0]] = len(horses) + 1
        horses.extend(ids)
    if len(horses) != len(set(horses)) or not all(1 <= n <= 18 for n in horses):
        return {}
    return output
