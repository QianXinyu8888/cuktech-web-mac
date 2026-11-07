import time
from .test_ble_manager import make_manager
from ble_manager import END_REASON_LINK_LOSS


def test_unrelated_mode_change_preserves_permanent_curve():
    mgr = make_manager()
    mgr.set_permanent_ports(['c1'])
    mgr._append_permanent_point(1,20,1,'PD',timestamp=time.time())
    mgr.set_permanent_ports(['c1','c2'])
    assert len(mgr._permanent_points[1]) == 1


def test_link_loss_carries_once_budget_across_sessions():
    mgr = make_manager()
    mgr.record_sessions = False
    mgr.set_charge_limits({'c1': {'wh':10,'mode':'once'}})
    es = mgr._energy_states[1]
    es.is_charging = True
    es.session_start = time.time()-720
    es.session_wh = 8
    mgr._active_sessions[1] = -1
    mgr._close_active_sessions(END_REASON_LINK_LOSS)
    mgr._start_session(1,time.time(),20,2,'PD')
    es.session_wh = 2.1
    mgr._enforce_charge_limit(1,time.time())
    assert mgr.cmd_queue.qsize() == 1
