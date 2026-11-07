"""设备识别：从一次充电会话的电气特征，推断"插着的是什么"。

**先说清楚能力边界**：充电器只能读到每个口的电压、电流与协商出来的快充协议。
USB PD / PPS / UFCS 这些协议本身**不携带品牌型号**（不像蓝牙有设备名），
所以"这是 iPhone 15"这种结论在物理上无法从充电数据里读出来。

那这个模块能做什么？三件事，按可靠性从高到低：

1. **设备类别**（笔记本 / 手机 / 平板 / 小电流设备 / 充电宝）——比较可靠：
   20V 档、40W 以上基本只有笔记本；5V 小电流多半是耳机手表。
2. **品牌家族**（华为荣耀系 / 苹果系 / 三星 Pixel 系 / 通用国产）——中等可靠：
   SCP 是华为系私有协议；UFCS 是国产新机统一快充；9V/2A 的 PD 很像 iPhone
   的 20W 档。属于"猜"，界面上必须标成推测。
3. **同款设备识别**——最可靠：用户手动标记一次"这是 MacBook Air"，之后凡是
   充电特征落到同一签名的会话都自动套用这个名字。这一条不依赖任何猜测。

签名（signature）就是把上面几个特征量化成字符串：主协议 + 峰值功率档 + 最高
电压档。同一台设备重复插拔会得到同一个签名；两台功率档相同的不同手机可能撞
签名——这是接受的设计取舍（宁可在界面上标"推测"，也不假装能分辨）。
"""

from __future__ import annotations

from typing import Dict, Optional

# 设备类别（前端用 charge.devClass.<key> 取文案，取不到就显示 cls_label）
CLASS_LABELS = {
    "laptop": "笔记本",
    "tablet": "平板",
    "phone": "手机",
    "small": "耳机/手表",
    "powerbank": "充电宝/配件",
    "unknown": "未知设备",
}

# 品牌家族（前端用 charge.devBrand.<key>）
BRAND_LABELS = {
    "huawei": "华为/荣耀系",
    "apple": "苹果系",
    "samsung": "三星/Pixel 系",
    "generic_cn": "国产快充机型",
    "unknown": "",
}

# 最接近的电压档：签名里用"离散档位"而不是精确值，避免 20.1 / 20.2 被当成两台
_VOLT_STEPS = (5, 9, 12, 15, 20, 28)


def _num(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _bucket_volt(max_v: float) -> int:
    """把最高电压归到最近的档位（5/9/12/15/20/28）。"""
    if max_v <= 0:
        return 0
    return min(_VOLT_STEPS, key=lambda v: abs(v - max_v))


def _protocol_list(row: dict) -> list[str]:
    """会话用过的协议：优先 protocols（逗号串，按频次排序），退回单值 protocol。"""
    raw = (row.get("protocols") or "").strip()
    if raw:
        items = [p.strip() for p in raw.split(",") if p.strip()]
    else:
        single = (row.get("protocol") or "").strip()
        items = [single] if single else []
    return [p for p in items if p.lower() not in ("idle", "5v", "")]


def _peak(row: dict) -> float:
    return _num(row.get("peak_power_w"))


def _max_voltage(row: dict) -> float:
    max_v = _num(row.get("max_voltage"))
    if max_v > 0:
        return max_v
    # 活跃会话还没算 max_voltage：用均压兜底（会低估一点，但方向没错）
    return _num(row.get("avg_voltage"))


def signature(row: dict) -> str:
    """充电签名：主协议 | 峰值功率档(5W) | 电压档。

    峰值按 5W 取整而不是精确值：同一台笔记本不同电量下 58W / 61W 很常见，
    精确匹配等于每次都是新设备，标记就永远学不会。
    """
    protos = _protocol_list(row)
    proto = protos[0].upper() if protos else "UNKNOWN"
    peak = _peak(row)
    # 5W 以下（耳机/手表）按 5W 取整会全部塌成 0，改用 1W 粒度：这个档位本来就
    # 是靠"小电流"识别的，粗化到 0 会让所有小设备共用同一个签名。
    if peak <= 0:
        peak_bucket = 0
    elif peak < 5:
        peak_bucket = int(round(peak))
    else:
        peak_bucket = int(round(peak / 5.0) * 5)
    return f"{proto}|{peak_bucket}|{_bucket_volt(_max_voltage(row))}"


def _parse_sig(sig: str):
    """把签名串拆回 (主协议, 峰值档W, 电压档)，解析失败返回 None。"""
    parts = (sig or "").split("|")
    if len(parts) != 3:
        return None
    proto, peak, volt = parts
    try:
        return proto.upper(), int(peak), int(volt)
    except ValueError:
        return None


def best_match(row: dict, labels: Optional[Dict[str, dict]],
               tol_w: int = 5, min_peak_w: float = 8.0) -> Optional[dict]:
    """容差匹配：在用户标记过的设备里找"特征最接近"的那一台。

    精确签名匹配要求峰值档完全一致，但充电是动态的：笔记本起步 24W（档 25）、
    爬到 32W（档 30）签名就变了，识别会中途翻转。这里放宽为——
      · 主协议相同；
      · 电压档完全相同（电压是硬特征，20V 的本不会像 9V 的手机）；
      · 峰值档差 ≤ tol_w（默认 5W，一档以内）；
      · 满足条件的候选里取最近的一个，**距离并列即视为歧义，宁可不认**；
      · 峰值还没爬到 min_peak_w 时不参与容差匹配（起步阶段特征不可信，
        但精确匹配不受此限——那说明用户真的标记过这个早期形态）。
    返回 {signature, name, label, distance} 或 None。
    """
    protos = _protocol_list(row)
    proto = protos[0].upper() if protos else ""
    if not proto:
        return None
    peak = _peak(row)
    if peak < min_peak_w:
        return None
    row_volt = _bucket_volt(_max_voltage(row))
    if row_volt <= 0:
        return None
    row_peak_bucket = int(round(peak / 5.0) * 5) if peak >= 5 else int(round(peak))
    best = None  # (distance, signature, name, label)；歧义时 signature 置 None
    for sig, label in (labels or {}).items():
        name = (label.get("name") or "").strip() if isinstance(label, dict) else ""
        if not name:
            continue
        parsed = _parse_sig(sig)
        if not parsed:
            continue
        l_proto, l_peak, l_volt = parsed
        if l_proto != proto or l_volt != row_volt:
            continue
        dist = abs(l_peak - row_peak_bucket)
        if dist > tol_w:
            continue
        if best is None or dist < best[0]:
            best = (dist, sig, name, label)
        elif dist == best[0]:
            best = (dist, None, None, None)
    if not best or best[1] is None:
        return None
    return {"signature": best[1], "name": best[2], "label": best[3],
            "distance": best[0]}


def classify(row: dict) -> dict:
    """按电气特征猜类别与品牌家族，返回 {cls, brand, confidence, hint}。

    confidence 只表达"这条规则的把握"，不是统计学概率：给用户看的措辞是
    "推测"，而不是精确度承诺。
    """
    peak = _peak(row)
    max_v = _max_voltage(row)
    avg_v = _num(row.get("avg_voltage"))
    protos = [p.upper() for p in _protocol_list(row)]
    has = lambda name: any(name in p for p in protos)  # noqa: E731
    cls, brand, conf = "unknown", "unknown", 0.2

    if peak >= 45 and max_v >= 15:
        # 20V 档 + 45W 以上：轻薄本 / 高性能本，PD 或 PPS 供电
        cls, conf = "laptop", 0.75
    elif peak >= 30 and max_v >= 15:
        # 15V/20V 但功率不大：平板（iPad Pro 30W 档）或低功耗本
        cls, brand, conf = ("tablet", "apple", 0.55) if peak <= 35 else ("laptop", "unknown", 0.5)
    elif has("SCP"):
        # 华为系私有快充（SCP/SuperCharge），协议本身就是最强线索
        cls, brand, conf = "phone", "huawei", 0.7
    elif has("UFCS"):
        cls, brand, conf = "phone", "generic_cn", 0.55
    elif max_v >= 15 and peak >= 20:
        # 协商到了 15V/20V 但功率不高（20~30W）：轻薄本待机充电的典型形态。
        # 手机极少走 20V 档，所以这里不能落到"手机"上。
        cls, conf = "laptop", 0.5
    elif max_v >= 15 and peak >= 12:
        # 15V/20V 但功率很低：平板（iPad 30W 档用到 15V）或小功率本
        cls, conf = "tablet", 0.45
    elif has("PPS") and 15 <= peak <= 45:
        cls, brand, conf = "phone", "samsung", 0.45
    elif peak >= 18 and 8 <= max_v <= 12:
        # 9V/2A 附近、20W 上下：iPhone 20W 档最典型，但大量安卓也长这样
        cls, brand, conf = "phone", "apple", 0.4
    elif peak < 7:
        cls, conf = "small", 0.65
    elif peak < 18 and max_v <= 5.6:
        cls, conf = "powerbank", 0.45
    elif peak >= 7:
        cls, conf = "phone", 0.35

    hint = ""
    if cls == "laptop" and avg_v >= 19:
        hint = "20V 恒压档，典型笔记本供电"
    elif cls == "small":
        hint = "小电流慢充，多为耳机/手表/键鼠"

    return {"cls": cls, "brand": brand, "confidence": conf, "hint": hint}


def identify(row: dict, labels: Optional[Dict[str, dict]] = None) -> dict:
    """给一条会话算出设备信息。

    返回 {name, cls, cls_label, brand, brand_label, confidence, source, signature, hint}
    source: 'labeled' = 用户标记过的签名命中；'guessed' = 纯推测。
    """
    sig = signature(row)
    guess = classify(row)
    result = {
        "signature": sig,
        "cls": guess["cls"],
        "cls_label": CLASS_LABELS.get(guess["cls"], guess["cls"]),
        "brand": guess["brand"],
        "brand_label": BRAND_LABELS.get(guess["brand"], ""),
        "confidence": guess["confidence"],
        "hint": guess["hint"],
        "source": "guessed",
        "name": "",
    }
    label = (labels or {}).get(sig)
    if label and (label.get("name") or "").strip():
        result["name"] = label["name"].strip()
        result["source"] = "labeled"
        result["confidence"] = 1.0
        result["exact"] = True
        if label.get("cls"):
            result["cls"] = label["cls"]
            result["cls_label"] = CLASS_LABELS.get(label["cls"], label["cls"])
    else:
        # 精确签名没命中：在标记库里做容差匹配（协议+电压档相同、峰值差一档以内）。
        # 充电是动态的，峰值从 24W 爬到 32W 签名就会换档——纯精确匹配会让识别
        # 中途翻转。容差命中同样算"识别出了你标记过的设备"。
        m = best_match(row, labels)
        if m:
            result["name"] = m["name"]
            result["source"] = "labeled"
            result["exact"] = False
            result["confidence"] = 0.7
            result["matched_signature"] = m["signature"]
            lbl = m["label"] or {}
            if lbl.get("cls"):
                result["cls"] = lbl["cls"]
                result["cls_label"] = CLASS_LABELS.get(lbl["cls"], lbl["cls"])
    return result
