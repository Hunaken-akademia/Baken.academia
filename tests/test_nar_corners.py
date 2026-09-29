from baken_academia.nar_corners import unambiguous_ranks
from scripts.nar_corner_snapshot_audit import estimate, sequence, stage_position


def test_grouped_horses_not_assigned_fake_exact_ranks():
    assert unambiguous_ranks("6 , 10 , 2 , ( 3 , 9 )- 7 , 5 , ( 4 , 8 ) , 1") == {6:1,10:2,2:3,7:6,5:7,1:10}
    assert unambiguous_ranks("３，１，２") == {3:1,1:2,2:3}
    assert unambiguous_ranks("1,2,1") == {}
    assert unambiguous_ranks("race 1,2") == {}
    assert unambiguous_ranks("(1,2,3") == {}


def test_weighted_estimate_matches_typescript_reference():
    history = [sequence("2-3-4"), sequence("8-8-9-10")]
    assert stage_position(history[0], 1) is None
    assert stage_position(history[0], 3) == 3
    point, previous = estimate(history, 4, 12)
    assert point == 60/9
    assert previous == 4
