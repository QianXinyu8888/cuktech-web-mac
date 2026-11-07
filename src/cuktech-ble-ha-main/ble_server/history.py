"""CUKTECH BLE Server - SQLite history storage for port data."""
import csv
import io
import json
import logging
import sqlite3
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

try:
    from energy import normalize_charge_limit, DEFAULT_LIMIT_MODE, LIMIT_MODE_ALWAYS
    from state import PORT_NAMES
except ImportError:
    import os as _os
    import sys as _sys
    _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
    from energy import normalize_charge_limit, DEFAULT_LIMIT_MODE, LIMIT_MODE_ALWAYS
    from state import PORT_NAMES

# 设备签名学习（end_session 收尾用）：标记发生在充电中时，签名还是"过程值"；
# 会话结束后按最终统计补一条同签名的学习记录，同一台设备下一次充电才能命中。
try:
    from device_ident import signature as _device_signature
except ImportError:  # pragma: no cover
    _device_signature = None

_LOGGER = logging.getLogger("cuktech_history")

DEFAULT_RETENTION_DAYS = 2
DEFAULT_DB_PATH = "port_history.db"
# primary 设备的存储身份（§3.10：history/meta/legacy topic 的兼容都锚定在这个 id 上）。
# 老库升级后所有既有行都归它，因此它同时是"未指定设备"的含义 —— 单设备部署下
# 所有 SQL 的行为与加列之前完全一致。
DEFAULT_DEVICE_ID = "default"


class PortHistory:
    """SQLite-based port history storage."""

    # 批量提交参数：降低高频采样下的写放大（每次 BLE 推送不再单独 COMMIT）
    BATCH_SIZE = 50          # 缓冲行数达到该值即强制提交
    # 距上次提交超过该秒数即强制提交。原先 1.0s，而 port_history 实际只有约
    # 0.8 行/秒，批量阈值永远达不到 → 变成"每秒一次 commit"（约 3600 次/小时）。
    # 放宽到 5s 可把提交次数降到约 1/5；读取路径都会先 flush()，不影响可见性。
    BATCH_INTERVAL = 5.0
    # WAL 回写下限：WAL 小于它就不做 checkpoint（SQLite 自带 wal_autocheckpoint
    # =1000 页兜底）。原先每 5 分钟无条件 PASSIVE 回写，WAL 很小时也照样把脏页
    # 抄回主库，是磁盘写入的主要来源之一。
    WAL_CHECKPOINT_MIN_BYTES = 4 * 1024 * 1024
    # 能量积分的采样断档上限（秒）：相邻采样点间隔超过它就按它计，防止闲置/掉线的
    # 空档被当成持续输出计入能量（fork 审查指出的"凭空计费"）。
    ENERGY_GAP_CAP_SEC = 30
    # 均压/均流重算时的采样断档上限（秒）：超过它的区间不参与加权，避免把中间的空载
    # 挂载段（v>0/i=0）或掉线空档计入均值。
    AVG_VI_GAP_CAP_SEC = 1800

    def __init__(self, db_path: str = DEFAULT_DB_PATH, retention_days: int = DEFAULT_RETENTION_DAYS):
        self.db_path = db_path
        self.retention_days = retention_days
        self._conn: Optional[sqlite3.Connection] = None
        self._db_lock = threading.Lock()  # 保护所有读写操作
        self._last_cleanup = 0
        self._last_wal_checkpoint = 0
        self._pending: list[tuple] = []   # 待批量写入的 port_history 行
        self._pending_points: list[tuple] = []  # 待批量写入的 charge_points 行
        self._last_commit = 0.0

    def connect(self):
        """Open database connection and create tables."""
        db_dir = Path(self.db_path).parent
        db_dir.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.execute("PRAGMA wal_autocheckpoint=1000")  # checkpoint every 1000 pages
        self._create_tables()
        # 崩溃/强杀遗留的未闭合会话（end_time IS NULL）在这里收尾：按采样点补算
        # 能量/峰值，结束时刻取最后一个采样点——**不是**整行删掉。删掉会把一整段
        # 充电的能量、均压均流、时长连同采样点一起丢掉，历史列表里也再看不见。
        # 只有能量过小的（<0.05Wh，等同没充过）才按常规口径删除，见该方法。
        # 这是启动清理的**唯一**入口：以前另有一个"直接 DELETE"的 reap，两者同时
        # 存在时后者（在 connect 里先跑）会把行删光，让这里的收尾永远无事可做。
        try:
            self.close_stale_sessions()
        except Exception as e:      # 兜底遗留失败不该拖垮整个启动
            _LOGGER.error("Failed to close stale sessions on startup: %s", e)
        # 老库的会话行没有"最低功率/最高电压/协议集合"，回填一次（meta 标记控制）。
        try:
            self.backfill_session_extras()
        except Exception as e:
            _LOGGER.error("Failed to backfill session extras: %s", e)
        self._cleanup_old_data()
        # 以连接时刻为提交基准：否则 _last_commit=0 会让启动后的第一个采样点
        # 立刻触发一次 flush（无谓的一次提交）。
        self._last_commit = time.time()
        _LOGGER.info("History database connected: %s", self.db_path)

    def close(self):
        """Close database connection with checkpoint and graceful shutdown."""
        if self._conn:
            with self._db_lock:
                # 落盘缓冲区中的采样，避免关闭时丢失最近 ~1s 的数据
                self._flush_pending()
            try:
                # Try to checkpoint WAL before closing
                self._conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except Exception:
                pass
            try:
                self._conn.close()
            except Exception:
                pass
            self._conn = None
            _LOGGER.info("History database closed")

    def _create_tables(self):
        """Create database tables and run migrations."""
        self._conn.executescript(f"""
            CREATE TABLE IF NOT EXISTS port_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp REAL NOT NULL,
                port INTEGER NOT NULL,
                voltage REAL,
                current REAL,
                power REAL,
                active INTEGER,
                protocol TEXT,
                device_id TEXT NOT NULL DEFAULT '{DEFAULT_DEVICE_ID}'
            );
            CREATE INDEX IF NOT EXISTS idx_port_history_port ON port_history(port);
            CREATE INDEX IF NOT EXISTS idx_port_history_timestamp ON port_history(timestamp);
            CREATE INDEX IF NOT EXISTS idx_port_history_port_time ON port_history(port, timestamp);
            -- device_id 相关索引**不在这里建**：旧库此刻还没有该列，建索引会直接
            -- 抛 "no such column" 让启动失败。ALTER 迁移之后再统一建（见 _create_tables 末尾）。

            CREATE TABLE IF NOT EXISTS charge_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                port INTEGER NOT NULL,
                start_time REAL NOT NULL,
                end_time REAL,
                total_wh REAL DEFAULT 0,
                avg_power_w REAL DEFAULT 0,
                peak_power_w REAL DEFAULT 0,
                avg_voltage REAL DEFAULT 0,
                avg_current REAL DEFAULT 0,
                duration_sec INTEGER DEFAULT 0,
                protocol TEXT DEFAULT '',
                created_at REAL DEFAULT (strftime('%s','now')),
                device_id TEXT NOT NULL DEFAULT '{DEFAULT_DEVICE_ID}'
            );
            CREATE INDEX IF NOT EXISTS idx_charge_sessions_port ON charge_sessions(port);
            CREATE INDEX IF NOT EXISTS idx_charge_sessions_start ON charge_sessions(start_time);
            -- idx_charge_sessions_device 同样挪到 ALTER 之后（旧库无 device_id 列）。

            CREATE TABLE IF NOT EXISTS charge_points (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL,
                timestamp REAL NOT NULL,
                voltage REAL,
                current REAL,
                power REAL,
                protocol TEXT DEFAULT '',
                FOREIGN KEY (session_id) REFERENCES charge_sessions(id)
            );
            CREATE INDEX IF NOT EXISTS idx_charge_points_session ON charge_points(session_id);
            CREATE INDEX IF NOT EXISTS idx_charge_points_timestamp ON charge_points(timestamp);

            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        """)
        # Migration: add protocol column to charge_points if missing
        try:
            self._conn.execute("SELECT protocol FROM charge_points LIMIT 1")
        except sqlite3.OperationalError:
            self._conn.execute("ALTER TABLE charge_points ADD COLUMN protocol TEXT DEFAULT ''")
            self._conn.commit()
        # Migration（§3.9）：旧库加 device_id 列。DEFAULT 'default' 让既有行自动归到
        # primary 设备——这正是"旧 history.db 无缝保留"的实现点：不需要回填脚本，
        # 不需要备份迁移，历史曲线/会话在升级后仍然只属于那台老设备。
        for table in ("port_history", "charge_sessions"):
            try:
                self._conn.execute(f"SELECT device_id FROM {table} LIMIT 1")
            except sqlite3.OperationalError:
                self._conn.execute(
                    f"ALTER TABLE {table} ADD COLUMN device_id "
                    f"TEXT NOT NULL DEFAULT '{DEFAULT_DEVICE_ID}'")
                _LOGGER.info("Migrated %s: added device_id column (default %r)",
                             table, DEFAULT_DEVICE_ID)
        self._conn.commit()
        # 索引在 ALTER 之后单独建：老库的 CREATE INDEX IF NOT EXISTS 已在上面跑过，
        # 但那时列还不存在，必须再建一次。
        self._conn.executescript(f"""
            CREATE INDEX IF NOT EXISTS idx_port_history_device_port_time
                ON port_history(device_id, port, timestamp);
            CREATE INDEX IF NOT EXISTS idx_charge_sessions_device
                ON charge_sessions(device_id, start_time);
        """)
        self._conn.commit()

        # 会话明细列（最低带载功率 / 最高电压 / 用过的协议集合 / 会话级设备名）：
        # 旧库补列后由 backfill_session_extras() 一次性回填。用 ALTER 而不是重建表，
        # 历史会话与它们的采样点原样保留。
        #
        # device_name（会话级设备名）解决"充电中标记不显示"：签名学习依赖的
        # peak/max_voltage/protocols 三列只在 end_session 时落库，活跃会话按行算
        # 签名必然对不上（PD|0|0 vs PD|25|9），标记的 chip 就永远停在"推测"。
        # 把名字同时写在本会话行上，显示时行名优先于签名命中——会话还在充也能
        # 立刻改名；结束后再按最终签名补一条学习记录（见 end_session）。
        #
        # start_pct / cap_wh（会话级电量起点与电池容量）解决"从 % 充到 %"：
        # 协议读不到设备电量，只能由用户填一个起点，再用本次充入的 Wh 反推。
        # 两列落在会话行上（而不是只存在档案里），历史记录才不会因为后来改档案
        # 而"变样"——这一次充了多少是事实，档案只是下次的默认值。
        for col, decl in (("min_power_w", "REAL DEFAULT 0"),
                          ("max_voltage", "REAL DEFAULT 0"),
                          ("protocols", "TEXT DEFAULT ''"),
                          ("device_name", "TEXT DEFAULT ''"),
                          ("start_pct", "REAL"),
                          ("cap_wh", "REAL"),
                          # 填电量那一刻已经充进去多少 Wh：用户可能在充了半小时之后
                          # 才想起来填"现在 42%"，那前面的 Wh 不能重复算进增量里。
                          ("pct_wh", "REAL DEFAULT 0")):
            try:
                self._conn.execute(f"SELECT {col} FROM charge_sessions LIMIT 1")
            except sqlite3.OperationalError:
                self._conn.execute(
                    f"ALTER TABLE charge_sessions ADD COLUMN {col} {decl}")
                _LOGGER.info("Migrated charge_sessions: added %s column", col)
        # 用户手动标记过的设备：按"充电签名"记名字，同档位/同协议的下一台设备
        # 自动套用（签名规则见 device_ident.py）。这是唯一能知道"这是什么手机"
        # 的来源——充电器只报 V/A/协议，读不到品牌型号。
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS device_labels (
                signature TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                cls TEXT DEFAULT '',
                sample_session_id INTEGER,
                updated_at REAL
            )
        """)
        # 电池档案：同一签名（≈同一台设备）只需要填一次品牌/型号/容量。
        # 下次插上来自动带出，用户只改"当前电量 %"这一个数字。
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS battery_profiles (
                signature TEXT PRIMARY KEY,
                brand TEXT DEFAULT '',
                model TEXT DEFAULT '',
                cap_wh REAL DEFAULT 0,
                cap_mah REAL DEFAULT 0,
                updated_at REAL
            )
        """)
        # 充电曲线学习：每台设备在各 SOC 区间的实测功率/峰值比例，按「品牌+型号」
        # 归档（跨端口共享，与 battery_profiles 同一归档口径）。预测时与默认衰减
        # 表加权融合 —— 同一台设备充得越多，预测越贴它自己的真实表现。
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS learn_curves (
                model_key TEXT PRIMARY KEY,
                curve TEXT NOT NULL,
                n INTEGER DEFAULT 0,
                peak_w REAL DEFAULT 0,
                updated_at REAL
            )
        """)
        self._conn.commit()

    # ── Runtime meta storage (single source for runtime toggles) ──

    @staticmethod
    def meta_key(key: str, device_id: str = DEFAULT_DEVICE_ID) -> str:
        """meta 键的设备命名空间（§3.9）。

        primary（`default`）**保持裸键**：旧库里的 `charge_limit_wh` /
        `session_recording` / `permanent_ports` / `full_off_ports` 就是这些键，
        升级后 primary 必须原样读到自己的设置。其他设备用 `{device_id}:{key}`。
        非 primary 不回落到裸键——那会让设备 2 继承设备 1 的限额（串台）。
        """
        if not device_id or device_id == DEFAULT_DEVICE_ID:
            return key
        return f"{device_id}:{key}"

    def get_meta(self, key: str, default: str = "") -> str:
        """Read a runtime meta value from the DB. Returns default if absent/failed."""
        if not self._conn:
            return default
        with self._db_lock:
            try:
                row = self._conn.execute(
                    "SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
                return row["value"] if row else default
            except Exception as e:
                _LOGGER.error("Failed to read meta %s: %s", key, e)
                return default

    def set_meta(self, key: str, value: str):
        """Persist a runtime meta value (upsert)."""
        if not self._conn:
            return
        with self._db_lock:
            try:
                self._conn.execute(
                    "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
                    (key, value))
                self._conn.commit()
            except Exception as e:
                _LOGGER.error("Failed to write meta %s: %s", key, e)

    def get_session_recording(self, *, device_id: str = DEFAULT_DEVICE_ID) -> bool:
        """Whether charge session recording is enabled (DB meta, default True)."""
        value = self.get_meta(self.meta_key("session_recording", device_id), "true").strip().lower()
        return value not in ("0", "false", "no", "off")

    def set_session_recording(self, enabled: bool, *, device_id: str = DEFAULT_DEVICE_ID) -> None:
        """Persist the charge session recording toggle (DB meta, survives restart)."""
        self.set_meta(self.meta_key("session_recording", device_id),
                      "true" if enabled else "false")

    # ── 端口模式集合（长期供电 / 充满即停，按端口名持久化） ──

    PERMANENT_PORTS_META_KEY = "permanent_ports"
    FULL_OFF_PORTS_META_KEY = "full_off_ports"

    @staticmethod
    def _clean_port_names(names) -> list:
        """把任意输入归一成合法端口名列表（去重、小写、保持 PORT_NAMES 顺序）。

        meta 脏数据 / 前端输入都不该让调用方崩溃：非法项静默丢弃。
        """
        valid = set(PORT_NAMES.values())
        if isinstance(names, str):
            names = [names]
        if not isinstance(names, (list, tuple, set, frozenset)):
            return []
        wanted = {str(n).strip().lower() for n in names}
        return [name for name in PORT_NAMES.values() if name in (wanted & valid)]

    def _get_port_set(self, key: str, device_id: str = DEFAULT_DEVICE_ID) -> list:
        """读取端口名集合（JSON 数组存 meta）；缺失/损坏一律回落空列表。"""
        raw = self.get_meta(self.meta_key(key, device_id), "")
        if not raw:
            return []
        try:
            stored = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            _LOGGER.warning("Port mode meta %s is not valid JSON, falling back to empty", key)
            return []
        return self._clean_port_names(stored)

    def _set_port_set(self, key: str, names, device_id: str = DEFAULT_DEVICE_ID) -> list:
        """写入端口名集合，返回归一后的列表（与读取对称，保证往返一致）。"""
        clean = self._clean_port_names(names)
        self.set_meta(self.meta_key(key, device_id), json.dumps(clean))
        return clean

    def get_permanent_ports(self, *, device_id: str = DEFAULT_DEVICE_ID) -> list:
        """长期供电设备端口（不写充电曲线点，会话统计照常记录）。"""
        return self._get_port_set(self.PERMANENT_PORTS_META_KEY, device_id)

    def set_permanent_ports(self, names, *, device_id: str = DEFAULT_DEVICE_ID) -> list:
        return self._set_port_set(self.PERMANENT_PORTS_META_KEY, names, device_id)

    def get_full_off(self, *, device_id: str = DEFAULT_DEVICE_ID) -> dict:
        """充满后自动关闭端口的端口 → 模式（once/always）。

        存储形状是 {端口名: mode}；兼容旧版本的数组形状（当时没有模式，语义等价于
        always：一直有效直到用户关掉），读到数组时统一升级成 always。
        """
        raw = self.get_meta(self.meta_key(self.FULL_OFF_PORTS_META_KEY, device_id), "")
        if not raw:
            return {}
        try:
            stored = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            _LOGGER.warning("Port mode meta %s is not valid JSON, falling back to empty",
                            self.FULL_OFF_PORTS_META_KEY)
            return {}
        if isinstance(stored, dict):
            out = {}
            for name in self._clean_port_names(list(stored.keys())):
                _, mode = normalize_charge_limit(0, stored.get(name))
                out[name] = mode
            return out
        # 旧形状：["c1"] → {"c1": "always"}
        return {name: LIMIT_MODE_ALWAYS for name in self._clean_port_names(stored)}

    def set_full_off(self, entries, *, device_id: str = DEFAULT_DEVICE_ID) -> dict:
        """写入 {端口名: mode}，返回归一后的字典（与读取对称）。"""
        if isinstance(entries, (list, tuple, set, frozenset)) or isinstance(entries, str):
            entries = {name: LIMIT_MODE_ALWAYS for name in self._clean_port_names(entries)}
        clean = {}
        if isinstance(entries, dict):
            for name in self._clean_port_names(list(entries.keys())):
                _, mode = normalize_charge_limit(0, entries.get(name))
                clean[name] = mode
        self.set_meta(self.meta_key(self.FULL_OFF_PORTS_META_KEY, device_id), json.dumps(clean))
        return clean

    def get_web_language(self) -> str:
        """Web UI language preference (DB meta, default 'auto' = follow system).

        **服务级 meta，刻意不做设备命名空间**（§3.9）：语言属于浏览器/服务，不属于
        某台充电器。调用方因此走 `s.history_store` 而不是 `s.history`（facade），
        免得看起来像"按设备读"却读到别人的设置。

        Returns 'auto' (follow system), 'zh-CN' or 'en'.
        """
        value = self.get_meta("web_language", "auto").strip().lower()
        if value in ("zh", "zh-cn", "zh-hans"):
            return "zh-CN"
        if value.startswith("en"):
            return "en"
        return "auto"

    def set_web_language(self, lang: str) -> None:
        """Persist the Web UI language preference (DB meta, survives restart)."""
        self.set_meta("web_language", lang)

    # ── Charge limits (自动断电阈值，单源 = DB meta) ──

    LIMIT_META_KEY = "charge_limit_wh"

    def get_charge_limits(self, *, device_id: str = DEFAULT_DEVICE_ID) -> dict:
        """读取各端口充电量阈值，返回 {port_name: {"wh": float, "mode": str}}。

        meta 缺失/JSON 损坏/字段类型非法时逐端口回落禁用（wh=0），不抛异常。
        端口名以 PORT_NAMES 为准（c1/c2/c3/a），meta 中的未知键忽略。
        """
        limits = {name: {"wh": 0.0, "mode": DEFAULT_LIMIT_MODE}
                  for name in PORT_NAMES.values()}
        raw = self.get_meta(self.meta_key(self.LIMIT_META_KEY, device_id), "")
        if not raw:
            return limits
        try:
            stored = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            _LOGGER.warning("Charge limits meta is not valid JSON, falling back to disabled")
            return limits
        if not isinstance(stored, dict):
            _LOGGER.warning("Charge limits meta is not an object, falling back to disabled")
            return limits
        for name in limits:
            entry = stored.get(name)
            if entry is None:
                continue
            if isinstance(entry, dict):
                wh, mode = normalize_charge_limit(entry.get("wh"), entry.get("mode"))
            else:
                # 兼容简写形式 {"c1": 30}
                wh, mode = normalize_charge_limit(entry, None)
            limits[name] = {"wh": wh, "mode": mode}
        return limits

    def set_charge_limits(self, limits: dict, *,
                          device_id: str = DEFAULT_DEVICE_ID) -> None:
        """Persist per-port charge limits as JSON in the meta table.

        入参形如 {port_name: {"wh": float, "mode": str}}；未知键忽略，
        非法值归一为禁用（与 get_charge_limits 对称，保证往返一致）。
        device_id 为关键字参数并置于末尾（保持单设备调用点不变）。
        """
        clean = {}
        for name in PORT_NAMES.values():
            entry = limits.get(name) if isinstance(limits, dict) else None
            if isinstance(entry, dict):
                wh, mode = normalize_charge_limit(entry.get("wh"), entry.get("mode"))
            else:
                wh, mode = normalize_charge_limit(entry, None)
            clean[name] = {"wh": wh, "mode": mode}
        self.set_meta(self.meta_key(self.LIMIT_META_KEY, device_id), json.dumps(clean))

    def _checkpoint_wal(self) -> bool:
        """WAL 达到阈值才回写主库（按阈值触发，而非无条件周期性回写）。

        SQLite 另有 wal_autocheckpoint=1000 页兜底；这里只是避免"WAL 还很小时
        也被强制回写"造成的多余磁盘写入。返回是否真的执行了 checkpoint。
        """
        try:
            wal_path = Path(str(self.db_path) + "-wal")
            if wal_path.exists() and wal_path.stat().st_size < self.WAL_CHECKPOINT_MIN_BYTES:
                return False
            self._conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
            return True
        except Exception:
            return False

    def _cleanup_old_data(self):
        """Remove data older than retention period (port samples + closed sessions)."""
        cutoff = time.time() - (self.retention_days * 86400)
        self._conn.execute("DELETE FROM port_history WHERE timestamp < ?", (cutoff,))
        # 清理过期闭环会话及其采样点（charge_sessions 行此前从不删除，会无限累积）
        self._conn.execute(
            """DELETE FROM charge_points WHERE session_id IN
               (SELECT id FROM charge_sessions WHERE end_time IS NOT NULL AND end_time < ?)""",
            (cutoff,))
        self._conn.execute(
            """DELETE FROM charge_sessions WHERE end_time IS NOT NULL AND end_time < ?""",
            (cutoff,))
        self._conn.commit()

    def flush(self):
        """强制将缓冲区中的采样批量落盘提交。线程安全。"""
        if not self._conn:
            return
        with self._db_lock:
            self._flush_pending()

    def _flush_pending(self):
        """将缓冲行批量 INSERT 并提交（port_history 与 charge_points 共用一次提交）。

        调用方必须已持有 _db_lock。
        """
        if not self._pending and not self._pending_points:
            return
        try:
            if self._pending:
                self._conn.executemany(
                    """INSERT INTO port_history (timestamp, port, voltage, current, power, active, protocol, device_id)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    self._pending,
                )
                self._pending.clear()
            if self._pending_points:
                self._conn.executemany(
                    """INSERT INTO charge_points (session_id, timestamp, voltage, current, power, protocol)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    self._pending_points,
                )
                self._pending_points.clear()
            self._conn.commit()
            self._last_commit = time.time()
            # 周期性清理/checkpoint 挂在提交路径上，只按时间间隔触发（每 1h / 5min）；
            # checkpoint 本身还会再判一次 WAL 阈值（见 _checkpoint_wal）。
            if self._last_commit - self._last_cleanup > 3600:
                self._cleanup_old_data()
                self._last_cleanup = self._last_commit
            if self._last_commit - self._last_wal_checkpoint > 300:
                self._checkpoint_wal()
                self._last_wal_checkpoint = self._last_commit
        except Exception as e:
            _LOGGER.error("Failed to record port data: %s", e)
            self._pending.clear()
            self._pending_points.clear()
            try:
                self._conn.rollback()
            except Exception:
                pass

    def record_port_data(self, port: int, data: dict, *,
                         device_id: str = DEFAULT_DEVICE_ID):
        """Record port data to database (synchronous, called from async via executor).

        批量缓冲：攒到 BATCH_SIZE 或距上次提交超过 BATCH_INTERVAL 再批量写入，
        大幅降低高频采样下的 COMMIT 次数与写放大。读取路径会自动 flush 未落盘
        的缓冲行，保证"写入后立即读取可见"。

        `device_id` 是**关键字参数且排在最后**（§3.9 的签名约束）：`port` 无默认值、
        `device_id` 有默认值，位置参数顺序不允许；而且既有 540 个用例都以
        `record_port_data(port, data)` 调用，加在第一位会全挂。缺省值 = primary，
        因此单设备部署的写入与加列之前逐字节等价。
        """
        if not self._conn:
            return
        row = (
            time.time(),
            port,
            data.get("voltage"),
            data.get("current"),
            data.get("power"),
            1 if data.get("active") else 0,
            data.get("protocol"),
            device_id,
        )
        with self._db_lock:
            self._pending.append(row)
            now = time.time()
            if (len(self._pending) >= self.BATCH_SIZE
                    or now - self._last_commit >= self.BATCH_INTERVAL):
                self._flush_pending()

    def query_history(
        self,
        port: int,
        hours: int = 24,
        interval: Optional[int] = None,
        *,
        device_id: str = DEFAULT_DEVICE_ID,
    ) -> list[dict]:
        """Query port history with optional downsampling.

        Args:
            port: Port number (1-4)
            hours: Number of hours to query
            interval: Aggregation interval in seconds (None = raw data)
            device_id: 只返回该设备的采样（缺省 primary ⇒ 与加列前一致）
        """
        if not self._conn:
            return []

        # 落盘缓冲采样，保证"写入后立即读取"的一致性（批量提交引入 ≤1s 缓冲）
        self.flush()

        cutoff = time.time() - (hours * 3600)

        if interval:
            rows = self._conn.execute(
                """SELECT
                    (CAST(timestamp / ? AS INTEGER) * ?) as bucket,
                    AVG(voltage) as voltage,
                    AVG(current) as current,
                    AVG(power) as power,
                    MAX(active) as active,
                    COUNT(*) as samples
                FROM port_history
                WHERE port = ? AND timestamp >= ? AND device_id = ?
                GROUP BY bucket
                ORDER BY bucket""",
                (interval, interval, port, cutoff, device_id)
            ).fetchall()
        else:
            rows = self._conn.execute(
                """SELECT timestamp, voltage, current, power, active, protocol
                FROM port_history
                WHERE port = ? AND timestamp >= ? AND device_id = ?
                ORDER BY timestamp""",
                (port, cutoff, device_id)
            ).fetchall()

        return [dict(row) for row in rows]

    def get_statistics(self, port: int, hours: int = 24, *,
                       device_id: str = DEFAULT_DEVICE_ID) -> dict:
        """Get statistical summary for a port."""
        if not self._conn:
            return {}

        self.flush()

        cutoff = time.time() - (hours * 3600)
        row = self._conn.execute(
            """SELECT
                COUNT(*) as samples,
                MIN(timestamp) as first_seen,
                MAX(timestamp) as last_seen,
                AVG(voltage) as avg_voltage,
                MAX(voltage) as max_voltage,
                MIN(voltage) as min_voltage,
                AVG(current) as avg_current,
                MAX(current) as max_current,
                AVG(power) as avg_power,
                MAX(power) as max_power,
                SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) as active_count,
                COALESCE(
                    (SELECT SUM(p.power * MIN(p.timestamp - p.prev_ts, ?)) / 3600.0
                     FROM (
                         SELECT timestamp, power,
                                LAG(timestamp) OVER (ORDER BY timestamp) as prev_ts
                         FROM port_history
                         WHERE port = ? AND timestamp >= ? AND active = 1 AND device_id = ?
                     ) p
                     WHERE p.prev_ts IS NOT NULL),
                0) as energy_wh
            FROM port_history
            WHERE port = ? AND timestamp >= ? AND device_id = ?""",
            # 采样断档上限 30s：闲置/掉线期间相邻两个采样点可能相隔很久, 不封顶会
            # 把这段空档按某个功率"积分"成能量（凭空计费）。
            (self.ENERGY_GAP_CAP_SEC, port, cutoff, device_id, port, cutoff, device_id)
        ).fetchone()

        if not row or row["samples"] == 0:
            return {"port": port, "hours": hours, "samples": 0}

        return {
            "port": port,
            "hours": hours,
            "samples": row["samples"],
            "first_seen": datetime.fromtimestamp(row["first_seen"]).isoformat() if row["first_seen"] else None,
            "last_seen": datetime.fromtimestamp(row["last_seen"]).isoformat() if row["last_seen"] else None,
            # 注意用 `is not None` 而不是真值判断：空载端口的 min/avg 就是 0，
            # 用真值判断会把它当成"没有数据"返回 null（历史遗留 bug）。
            "voltage": {
                "avg": round(row["avg_voltage"], 2) if row["avg_voltage"] is not None else None,
                "min": round(row["min_voltage"], 2) if row["min_voltage"] is not None else None,
                "max": round(row["max_voltage"], 2) if row["max_voltage"] is not None else None,
            },
            "current": {
                "avg": round(row["avg_current"], 2) if row["avg_current"] is not None else None,
                "max": round(row["max_current"], 2) if row["max_current"] is not None else None,
            },
            "power": {
                "avg": round(row["avg_power"], 2) if row["avg_power"] is not None else None,
                "max": round(row["max_power"], 2) if row["max_power"] is not None else None,
                "total_wh": round(row["energy_wh"], 2) if row["energy_wh"] is not None else 0,
            },
            "active_ratio": round(row["active_count"] / row["samples"], 2) if row["samples"] > 0 else 0,
        }

    def export_csv(self, port: int, hours: int = 24, *,
                   device_id: str = DEFAULT_DEVICE_ID) -> str:
        """Export port history as CSV string."""
        if not self._conn:
            return ""

        self.flush()

        cutoff = time.time() - (hours * 3600)
        rows = self._conn.execute(
            """SELECT timestamp, voltage, current, power, active, protocol
            FROM port_history
            WHERE port = ? AND timestamp >= ? AND device_id = ?
            ORDER BY timestamp""",
            (port, cutoff, device_id)
        ).fetchall()

        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["timestamp", "datetime", "voltage", "current", "power", "active", "protocol"])

        for row in rows:
            writer.writerow([
                row["timestamp"],
                datetime.fromtimestamp(row["timestamp"]).strftime("%Y-%m-%d %H:%M:%S"),
                row["voltage"],
                row["current"],
                row["power"],
                "yes" if row["active"] else "no",
                row["protocol"],
            ])

        return output.getvalue()

    def export_session_csv(self, session_id: int, *,
                           device_id: Optional[str] = None) -> str:
        """把**单个充电会话**的采样点导成 CSV。

        与 export_csv(port, hours) 的区别：那个按端口+时间窗导原始采样（包含会话之间的
        空载片段），这个只导某一次会话的点（充电曲线本体），供会话详情浮层的"导出"用。
        第一行是会话元信息（# 开头的注释行，Excel/Numbers 会当文本行保留），
        之后是标准表头 + 采样点。

        `device_id` 非 None 时校验会话归属（§3.9）：不属于该设备一律按"不存在"处理，
        不泄露"这个 id 存在"。None = 内部路径，不校验。
        """
        if not self._conn or not session_id:
            return ""

        self.flush()

        sess = self._conn.execute(
            """SELECT id, port, start_time, end_time, total_wh, avg_power_w, peak_power_w,
                      avg_voltage, avg_current, duration_sec, protocol, device_id
               FROM charge_sessions WHERE id = ?""",
            (session_id,),
        ).fetchone()
        if not sess or (device_id is not None and sess["device_id"] != device_id):
            return ""

        pts = self._conn.execute(
            """SELECT timestamp, voltage, current, power, protocol
               FROM charge_points WHERE session_id = ? ORDER BY timestamp""",
            (session_id,),
        ).fetchall()

        def _ts(v):
            return datetime.fromtimestamp(v).strftime("%Y-%m-%d %H:%M:%S") if v else ""

        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow([f"# session {sess['id']}",
                         f"port {PORT_NAMES.get(sess['port'], sess['port'])}",
                         f"protocol {sess['protocol'] or ''}"])
        writer.writerow([f"# start {_ts(sess['start_time'])}",
                         f"end {_ts(sess['end_time'])}",
                         f"duration_s {sess['duration_sec'] or 0}"])
        writer.writerow([f"# energy_wh {round(sess['total_wh'] or 0, 2)}",
                         f"avg_power_w {round(sess['avg_power_w'] or 0, 2)}",
                         f"peak_power_w {round(sess['peak_power_w'] or 0, 2)}"])
        writer.writerow([])
        writer.writerow(["timestamp", "datetime", "voltage", "current", "power", "protocol"])
        for p in pts:
            writer.writerow([
                p["timestamp"], _ts(p["timestamp"]),
                p["voltage"], p["current"], p["power"], p["protocol"],
            ])
        return output.getvalue()

    def query_history_multi(self, start_port: int, end_port: int, hours: float, interval: int,
                            *, device_id: str = DEFAULT_DEVICE_ID) -> list[dict]:
        """Query history for multiple ports in a single query."""
        if not self._conn:
            return []

        self.flush()

        cutoff = time.time() - (hours * 3600)
        rows = self._conn.execute(
            """SELECT port,
                (CAST(timestamp / ? AS INTEGER) * ?) as bucket,
                AVG(voltage) as voltage,
                AVG(current) as current,
                AVG(power) as power,
                COUNT(*) as samples
            FROM port_history
            WHERE port >= ? AND port <= ? AND timestamp >= ? AND device_id = ?
            GROUP BY port, bucket
            ORDER BY port, bucket""",
            (interval, interval, start_port, end_port, cutoff, device_id)
        ).fetchall()

        return [dict(row) for row in rows]

    # ── Charge Session Management ──

    def start_session(self, port: int, protocol: str = "",
                      start_time: Optional[float] = None, *,
                      device_id: str = DEFAULT_DEVICE_ID) -> int:
        """Start a new charge session, return session_id.

        start_time 显式传入时用它（开会话时会把起判前那 30s 回填进本会话，起点必须
        跟着回填，否则 start_time + duration_sec 会比 end_time 多出一截，历史行自相矛盾）。
        """
        if not self._conn:
            return 0
        with self._db_lock:
            try:
                cursor = self._conn.execute(
                    """INSERT INTO charge_sessions (port, start_time, protocol, device_id)
                       VALUES (?, ?, ?, ?)""",
                    (port, time.time() if start_time is None else float(start_time),
                     protocol, device_id),
                )
                self._conn.commit()
                return cursor.lastrowid
            except Exception as e:
                _LOGGER.error("Failed to start session: %s", e)
                return 0

    def record_charge_point(self, session_id: int, voltage: float,
                            current: float, power: float, protocol: str = ""):
        """缓冲一条会话采样点；攒够 BATCH_SIZE 或超过 BATCH_INTERVAL 才批量落盘。

        原先每点一次 INSERT + COMMIT（充电时约 0.8 点/秒 → 每秒一次 fsync），
        是磁盘写入放大的主要来源。现与 port_history 共用缓冲与同一次提交。
        读取路径（get_session_points / compute_session_avg_vi / end_session）
        都会先 flush()，保证"写入后立即读取可见"。
        """
        if not self._conn or not session_id:
            return
        row = (session_id, time.time(), voltage, current, power, protocol)
        with self._db_lock:
            self._pending_points.append(row)
            now = time.time()
            if (len(self._pending_points) >= self.BATCH_SIZE
                    or now - self._last_commit >= self.BATCH_INTERVAL):
                self._flush_pending()

    def record_charge_points(self, session_id: int, rows) -> int:
        """批量缓冲会话采样点（补写预会话回填用），返回入队条数。

        与 record_charge_point 共用同一个待写缓冲与提交节奏，区别只在：
          · 一次拿锁入队多行（回填最长 120 行，别逐行开 executor）；
          · 时间戳用采样时的真实时间，而不是入队时刻——否则回填的点会全部挤在
            "开会话"那一秒上，曲线头部被压成一根竖线。
        rows: 可迭代的 (timestamp, voltage, current, power, protocol)
        """
        if not self._conn or not session_id or not rows:
            return 0
        queued = [(session_id, float(t), v, i, p, proto) for t, v, i, p, proto in rows]
        with self._db_lock:
            self._pending_points.extend(queued)
            if (len(self._pending_points) >= self.BATCH_SIZE
                    or time.time() - self._last_commit >= self.BATCH_INTERVAL):
                self._flush_pending()
        return len(queued)

    def compute_session_avg_vi(self, session_id: int) -> tuple:
        """从本会话采样点计算时间加权均压/均流, 返回 (avg_v, avg_i) 或 (None, None)。

        闭合会话时传入的是"断电/低电流那一刻"的瞬时值(≈0), 直接落库会让历史
        摘要的均压/均流恒为 0。这里改用采样点做梯形(时间)加权平均, 与桌面端
        口径一致; 断档超过 30 分钟的区间不参与, 避免把空载挂载态拉低均值。
        """
        if not self._conn or not session_id:
            return None, None
        # 先把缓冲中的采样点落盘，否则会漏掉最近几秒的点，均值偏低
        self.flush()
        try:
            # 与写路径共用同一把锁：本方法会被 end_session / 启动回填在
            # executor 线程上调用，与 record_charge_point 的写并发访问同一条
            # sqlite 连接（check_same_thread=False），不加锁会读到写事务中间态。
            with self._db_lock:
                rows = self._conn.execute(
                    """SELECT timestamp, voltage, current FROM charge_points
                       WHERE session_id = ? ORDER BY timestamp""",
                    (session_id,)
                ).fetchall()
        except Exception as e:
            _LOGGER.error("Failed to read charge points for avg: %s", e)
            return None, None
        pts = [(r["timestamp"], r["voltage"], r["current"]) for r in rows
               if r["voltage"] is not None and r["current"] is not None]
        if len(pts) < 2:
            if len(pts) == 1:
                return float(pts[0][1]), float(pts[0][2])
            return None, None
        wsum = vsum = isum = 0.0
        for (t0, v0, i0), (t1, v1, i1) in zip(pts, pts[1:]):
            dt = t1 - t0
            if dt <= 0 or dt > self.AVG_VI_GAP_CAP_SEC:
                continue
            # 梯形加权: 区间内以两端均值代表该段
            wsum += dt
            vsum += dt * (v0 + v1) / 2.0
            isum += dt * (i0 + i1) / 2.0
        if wsum <= 0:
            # 全部区间都超限: 退化为算术平均, 至少不是 0
            return (sum(p[1] for p in pts) / len(pts),
                    sum(p[2] for p in pts) / len(pts))
        return vsum / wsum, isum / wsum

    def backfill_session_avg_vi(self) -> int:
        """启动回填: 重算历史中 avg=0 但有采样点的已闭合会话。返回修复行数。

        批量提交（单次 commit）而不是每条一次：启动阶段可能有大量历史脏行,
        逐条 fsync 会明显拖慢就绪时间。
        """
        if not self._conn:
            return 0
        fixed = 0
        updates = []
        try:
            with self._db_lock:
                ids = [r["id"] for r in self._conn.execute(
                    """SELECT id FROM charge_sessions
                       WHERE end_time IS NOT NULL
                         AND (avg_voltage IS NULL OR avg_voltage = 0)
                         AND EXISTS (SELECT 1 FROM charge_points
                                     WHERE session_id = charge_sessions.id)"""
                ).fetchall()]
        except Exception as e:
            _LOGGER.error("Failed to scan sessions for backfill: %s", e)
            return 0
        for sid in ids:
            avg_v, avg_i = self.compute_session_avg_vi(sid)
            if avg_v is None:
                continue
            updates.append((round(avg_v, 2), round(avg_i, 2), sid))
        if not updates:
            return 0
        try:
            with self._db_lock:
                self._conn.executemany(
                    """UPDATE charge_sessions
                       SET avg_voltage = ?, avg_current = ? WHERE id = ?""",
                    updates)
                self._conn.commit()
            fixed = len(updates)
        except Exception as e:
            _LOGGER.error("Failed to backfill session averages: %s", e)
            return 0
        if fixed:
            _LOGGER.info("Backfilled avg voltage/current for %d sessions", fixed)
        return fixed

    def end_session(self, session_id: int, total_wh: float, peak_power_w: float,
                    avg_voltage: float, avg_current: float, duration_sec: int,
                    end_time: Optional[float] = None):
        """End a charge session with final stats.

        avg_voltage/avg_current 传入的是闭合瞬间的瞬时值(通常已归零), 仅作为
        "没有采样点"时的回落; 有采样点时一律用采样点的时间加权均值重算。
        end_time 缺省为当前时刻；收尾遗留会话时传"最后一个采样点"更诚实。
        """
        if not self._conn or not session_id:
            return
        avg_power = total_wh / (duration_sec / 3600.0) if duration_sec > 0 else 0
        calc_v, calc_i = self.compute_session_avg_vi(session_id)
        if calc_v is not None:
            avg_voltage, avg_current = calc_v, calc_i
        # 明细三项（最低带载功率 / 最高电压 / 协议集合）也按采样点现算：
        # 闭合瞬间传入的瞬时值是 0V/0A，不能拿来当"这个会话用过什么"。
        min_power, max_voltage, protocols = self.compute_session_extras(session_id)
        with self._db_lock:
            try:
                self._conn.execute(
                    """UPDATE charge_sessions SET
                       end_time = ?, total_wh = ?, avg_power_w = ?,
                       peak_power_w = ?, avg_voltage = ?, avg_current = ?,
                       duration_sec = ?, min_power_w = ?, max_voltage = ?,
                       protocols = ?
                       WHERE id = ?""",
                    (end_time if end_time is not None else time.time(),
                     round(total_wh, 4), round(avg_power, 2),
                     round(peak_power_w, 2), round(avg_voltage, 2),
                     round(avg_current, 2), duration_sec,
                     round(min_power, 2), round(max_voltage, 2),
                     protocols, session_id),
                )
                self._conn.commit()
            except Exception as e:
                _LOGGER.error("Failed to end session: %s", e)
        # 会话级名字 → 签名学习的收尾：充电中标记的名字已写在本行上，此刻最终
        # 签名（峰值/电压档/协议集合）才算得准。若该签名还没有任何标记，就用本行
        # 的名字补一条——同一台设备"下一次充电"才能自动套用这个名字。
        # 失败只丢一次学习机会，不影响会话收尾本身。
        if _device_signature is not None:
            try:
                self._learn_session_label(session_id)
            except Exception as e:
                _LOGGER.error("Failed to learn session label for %s: %s", session_id, e)
        # 充电曲线学习：收尾后把实测的 SOC-功率曲线按型号归档（充电中填过
        # 起始电量与容量才有分母）。失败只丢一次学习机会，不影响会话收尾。
        try:
            self.learn_session_curve(session_id)
        except Exception as e:
            _LOGGER.error("Failed to learn charge curve for %s: %s", session_id, e)

    def _learn_session_label(self, session_id: int) -> None:
        """会话收尾后按最终签名回填学习记录（行上有名字时）。

        名字来源有两种：用户在本会话上标记/更正的，或自动识别命中标记设备后
        钉住的。该签名已有一条**同名**标记就不再重复写；名字不同说明用户在这条
        会话上做过更正——以本次更正为准覆盖旧标记，"改一次就一直是对的"。
        """
        with self._db_lock:
            row = self._conn.execute(
                "SELECT device_name, protocol, peak_power_w, max_voltage, protocols "
                "FROM charge_sessions WHERE id = ?", (session_id,)).fetchone()
        name = ((row["device_name"] if row else "") or "").strip()
        if not name or not row:
            return
        sig = _device_signature({
            "protocol": row["protocol"],
            "peak_power_w": row["peak_power_w"],
            "max_voltage": row["max_voltage"],
            "protocols": row["protocols"],
        })
        with self._db_lock:
            existing = self._conn.execute(
                "SELECT name FROM device_labels WHERE signature = ?", (sig,)).fetchone()
        if existing and (existing["name"] or "").strip() == name:
            return
        self.upsert_device_label(sig, name, "", session_id)
        if existing:
            _LOGGER.info("Updated device label for %s: %r -> %r (from session %s)",
                         sig, existing["name"], name, session_id)
        else:
            _LOGGER.info("Learned device label %r for signature %s from session %s",
                         name, sig, session_id)

    def set_session_device_name(self, session_id: int, name: str) -> None:
        """把用户起的名字写在本会话行上（显示时优先于签名命中）。

        name 为空串视为清除。充电中的会话也能立即生效——这正是它的存在理由：
        签名学习要等会话结束才知道最终档位，而显示不能等。
        """
        if not self._conn or not session_id:
            return
        with self._db_lock:
            try:
                self._conn.execute(
                    "UPDATE charge_sessions SET device_name = ? WHERE id = ?",
                    ((name or "").strip()[:60], session_id))
                self._conn.commit()
            except Exception as e:
                _LOGGER.error("Failed to set device name for session %s: %s",
                              session_id, e)

    def compute_session_totals(self, session_id: int) -> tuple:
        """按采样点现算本次会话的 (能量 Wh, 峰值功率 W)。

        会话进行中 charge_sessions.total_wh / peak_power_w 还是 0（只在
        end_session 时才写），所以收尾遗留会话不能信这两列，得按点现算——
        与前端曲线的梯形积分同一口径，断档超限的区间不参与。
        """
        if not self._conn or not session_id:
            return 0.0, 0.0
        with self._db_lock:
            self._flush_pending()
            rows = self._conn.execute(
                """SELECT timestamp, power FROM charge_points
                   WHERE session_id = ? ORDER BY timestamp""",
                (session_id,)).fetchall()
        pts = [(r["timestamp"], r["power"] or 0.0) for r in rows]
        if not pts:
            return 0.0, 0.0
        peak = max(p for _, p in pts)
        if len(pts) < 2:
            return 0.0, peak
        wh = 0.0
        for (t0, p0), (t1, p1) in zip(pts, pts[1:]):
            dt = t1 - t0
            if dt <= 0 or dt > self.AVG_VI_GAP_CAP_SEC:
                continue
            wh += (p0 + p1) / 2.0 * dt / 3600.0
        return wh, peak

    def compute_session_extras(self, session_id: int) -> tuple:
        """按采样点现算 (最低带载功率, 最高电压, 协议集合)。

        最低功率只统计"带载"的点（>0.5W）：会话头尾的 0W 斜坡、拔线瞬间的 0
        都不是"这次充电充得最低"，算进去会让每个会话的最低功率恒为 0，指标就废了。
        协议按出现次数排序后去重拼接（第一个即主协议），空串协议忽略。
        """
        if not self._conn or not session_id:
            return 0.0, 0.0, ""
        with self._db_lock:
            self._flush_pending()
            rows = self._conn.execute(
                """SELECT power, voltage, protocol FROM charge_points
                   WHERE session_id = ?""", (session_id,)).fetchall()
        if not rows:
            return 0.0, 0.0, ""
        powers = [float(r["power"] or 0) for r in rows]
        voltages = [float(r["voltage"] or 0) for r in rows]
        loaded = [p for p in powers if p > 0.5]
        min_power = min(loaded) if loaded else 0.0
        max_voltage = max(voltages) if voltages else 0.0
        counts: dict[str, int] = {}
        for r in rows:
            proto = (r["protocol"] or "").strip()
            # 'idle' 与 '5V' 都不是快充协议：前者是空载占位，后者是"没协商出快充"
            # 的档位标记。把它们写进"协议"会让每次普通充电都显示一个假协议。
            if proto and proto.lower() not in ("idle", "5v"):
                counts[proto] = counts.get(proto, 0) + 1
        ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
        return min_power, max_voltage, ",".join(k for k, _ in ordered)

    def backfill_session_extras(self) -> int:
        """一次性回填历史会话的 min_power_w / max_voltage / protocols。

        用 meta 标记控制"只跑一次"：老库可能几百条会话，每次启动都全表重算
        是白烧 IO，而这三列不会因为时间推移而变化。
        """
        flag = "session_extras_backfilled_v1"
        if not self._conn or self.get_meta(flag) == "1":
            return 0
        with self._db_lock:
            try:
                rows = self._conn.execute(
                    """SELECT id FROM charge_sessions
                       WHERE end_time IS NOT NULL
                         AND (protocols IS NULL OR protocols = '')
                       ORDER BY id DESC LIMIT 500"""
                ).fetchall()
            except Exception as e:
                _LOGGER.error("Failed to list sessions for extras backfill: %s", e)
                return 0
        fixed = 0
        for row in rows:
            sid = row["id"]
            min_p, max_v, protocols = self.compute_session_extras(sid)
            with self._db_lock:
                try:
                    self._conn.execute(
                        """UPDATE charge_sessions
                           SET min_power_w = ?, max_voltage = ?, protocols = ?
                           WHERE id = ?""",
                        (round(min_p, 2), round(max_v, 2), protocols, sid))
                    fixed += 1
                except Exception as e:
                    _LOGGER.error("Backfill extras failed for session %s: %s", sid, e)
        with self._db_lock:
            try:
                self._conn.commit()
            except Exception:
                pass
        self.set_meta(flag, "1")
        if fixed:
            _LOGGER.info("Backfilled session extras for %d session(s)", fixed)
        return fixed

    def close_stale_sessions(self, device_id: Optional[str] = None) -> int:
        """收尾上一次进程遗留的未闭合会话（end_time IS NULL），返回处理条数。

        正常关机时 BLEManager._close_active_sessions 会把它们写完整；只有被强杀
        /崩溃才会留下这种行——列表会永远把它们当"充电中"。能量与峰值按采样点
        现算（进行中的行这两列还是 0），结束时刻取最后一个采样点（没有点就退回
        start_time）；能量过小的按常规口径删除，避免留下 0Wh 空行。

        启动清理的唯一入口是 connect()（运行中不能调用：那时 end_time IS NULL
        就是"正在充电"的正常状态）。

        `device_id=None`（缺省）= **全设备**收尾，正是 connect() 要的语义：多设备下
        若按某一台收尾，其他设备崩溃遗留的行会永远挂在库里（幽灵会话、once 限额
        永不释放）。`DeviceHistory` facade 传自己的 id，只收本设备。
        """
        if not self._conn:
            return 0
        device_clause = "" if device_id is None else " AND device_id = ?"
        device_params: tuple = () if device_id is None else (device_id,)
        with self._db_lock:
            self._flush_pending()
            rows = self._conn.execute(
                """SELECT id, start_time, total_wh, peak_power_w
                   FROM charge_sessions WHERE end_time IS NULL""" + device_clause,
                device_params).fetchall()
        closed = 0
        for row in rows:
            sid = row["id"]
            with self._db_lock:
                last = self._conn.execute(
                    "SELECT MAX(timestamp) AS ts FROM charge_points WHERE session_id = ?",
                    (sid,)).fetchone()
            start_ts = row["start_time"] or time.time()
            end_ts = (last["ts"] if last and last["ts"] else None) or start_ts
            if end_ts < start_ts:
                end_ts = start_ts
            total_wh = row["total_wh"] or 0.0
            peak = row["peak_power_w"] or 0.0
            if total_wh <= 0 or peak <= 0:
                calc_wh, calc_peak = self.compute_session_totals(sid)
                total_wh = total_wh or calc_wh
                peak = peak or calc_peak
            if total_wh < 0.05:      # 与 _close_session 同一门槛：没有能量的行不留
                self.delete_session(sid)
            else:
                self.end_session(sid, total_wh, peak, 0.0, 0.0,
                                 int(end_ts - start_ts), end_time=end_ts)
            closed += 1
        if closed:
            _LOGGER.info("Closed %d stale session(s) left open by a previous run", closed)
        return closed

    def delete_session(self, session_id: int):
        """Internal cleanup of a finished/discarded session, including an open 0Wh row."""
        self.delete_sessions([session_id], _allow_active=True)

    def delete_sessions(self, session_ids, *,
                        device_id: Optional[str] = None,
                        _allow_active: bool = False) -> int:
        """批量删除充电会话及其采样点，返回实际删除条数。

        活跃会话（end_time IS NULL）一律跳过：BLE 还在往里写采样点，删了行
        缓冲的点 flush 后又会插回来，还会让列表与实时状态自相矛盾。
        `device_id` 非 None 时只删该设备名下的会话（Web 端走 DeviceHistory
        facade 必然带；内部清理路径传 None 表示全设备）。
        """
        if not self._conn:
            return 0
        ids: list = []
        for sid in (session_ids or []):
            try:
                ids.append(int(sid))
            except (TypeError, ValueError):
                continue
        ids = [i for i in ids if i > 0]
        if not ids:
            return 0
        with self._db_lock:
            try:
                # 缓冲中的点要先落盘再删，否则删除之后 flush 会把它们又插回来。
                self._flush_pending()
                marks = ",".join("?" * len(ids))
                # Only internal discarded-session cleanup may remove an open row.
                active_clause = "" if _allow_active else " AND end_time IS NOT NULL"
                if device_id is not None:
                    rows = self._conn.execute(
                        f"""SELECT id FROM charge_sessions
                            WHERE id IN ({marks}) AND device_id = ?""" + active_clause,
                        (*ids, device_id)).fetchall()
                else:
                    rows = self._conn.execute(
                        f"""SELECT id FROM charge_sessions
                            WHERE id IN ({marks})""" + active_clause,
                        ids).fetchall()
                del_ids = [r["id"] for r in rows]
                if not del_ids:
                    return 0
                dm = ",".join("?" * len(del_ids))
                self._conn.execute(
                    f"DELETE FROM charge_points WHERE session_id IN ({dm})", del_ids)
                cur = self._conn.execute(
                    f"DELETE FROM charge_sessions WHERE id IN ({dm})", del_ids)
                self._conn.commit()
                return cur.rowcount
            except Exception as e:
                _LOGGER.error("Failed to delete sessions %s: %s", ids, e)
                try:
                    self._conn.rollback()
                except Exception:
                    pass
                return 0

    def clear_sessions(self, *, device_id: Optional[str] = None) -> int:
        """清空（已结束的）充电会话与采样点；活跃会话保留。返回删除条数。"""
        if not self._conn:
            return 0
        with self._db_lock:
            try:
                self._flush_pending()
                if device_id is not None:
                    rows = self._conn.execute(
                        """SELECT id FROM charge_sessions
                           WHERE device_id = ? AND end_time IS NOT NULL""",
                        (device_id,)).fetchall()
                else:
                    rows = self._conn.execute(
                        "SELECT id FROM charge_sessions WHERE end_time IS NOT NULL").fetchall()
                ids = [r["id"] for r in rows]
                if not ids:
                    return 0
                dm = ",".join("?" * len(ids))
                self._conn.execute(
                    f"DELETE FROM charge_points WHERE session_id IN ({dm})", ids)
                cur = self._conn.execute(
                    f"DELETE FROM charge_sessions WHERE id IN ({dm})", ids)
                self._conn.commit()
                return cur.rowcount
            except Exception as e:
                _LOGGER.error("Failed to clear sessions: %s", e)
                try:
                    self._conn.rollback()
                except Exception:
                    pass
                return 0

    # ── 记录筛选（前端"端口 / 设备"下拉）──
    #
    # 设备名有两个来源：会话行上的 device_name（充电中钉住的），或按签名命中的
    # device_labels。签名没法在 SQL 里算（要按峰值/电压档/协议集合现算），所以
    # 设备筛选走"按周期取全量行 → Python 过滤 → 内存分页"的路径；保留期默认
    # 2 天，行数有限，成本可接受。

    _SESSION_COLS = ("id, port, start_time, end_time, total_wh, avg_power_w, "
                     "peak_power_w, avg_voltage, avg_current, duration_sec, protocol, "
                     "min_power_w, max_voltage, protocols, device_name, "
                     "start_pct, cap_wh, pct_wh")

    def _row_device_sig(self, row: dict) -> str:
        if _device_signature is None:
            return ""
        try:
            return _device_signature({
                "protocol": row.get("protocol"),
                "peak_power_w": row.get("peak_power_w"),
                "max_voltage": row.get("max_voltage"),
                "protocols": row.get("protocols"),
            })
        except Exception:
            return ""

    def _sessions_in_period(self, period: str, port: Optional[int], *,
                            device_id: str, include_active: bool) -> list[dict]:
        start, end = self._period_window(period)
        where = ("start_time >= ?"
                 + (" AND start_time < ?" if end is not None else "")
                 + " AND device_id = ?")
        if not include_active:
            where += " AND end_time IS NOT NULL"
        params: list = ([start] if end is None else [start, end]) + [device_id]
        if port is not None:
            where += " AND port = ?"
            params.append(port)
        rows = self._conn.execute(
            f"SELECT {self._SESSION_COLS} FROM charge_sessions WHERE {where}",
            params).fetchall()
        return [dict(r) for r in rows]

    @staticmethod
    def _match_device(row: dict, names: set, sigs: set) -> bool:
        return ((row.get("device_name") or "") in names
                or (row.get("_sig") or "") in sigs)

    def _attach_sig(self, rows: list[dict]) -> list[dict]:
        for r in rows:
            r["_sig"] = self._row_device_sig(r)
        return rows

    def get_sessions_filtered(self, port: Optional[int], period: str,
                              device_names, limit: int, offset: int, *,
                              device_id: str = DEFAULT_DEVICE_ID) -> tuple:
        """按设备名筛选会话（get_sessions 的设备筛选版，行形状与之一致）。"""
        if not self._conn:
            return [], 0
        names = {str(n).strip() for n in (device_names or []) if str(n).strip()}
        if not names:
            return self.get_sessions(port, period, limit, offset, device_id=device_id)
        with self._db_lock:
            self._flush_pending()
            rows = self._attach_sig(self._sessions_in_period(
                period, port, device_id=device_id, include_active=True))
        labels = self.get_device_labels()
        sigs = {sig for sig, l in labels.items() if (l.get("name") or "") in names}
        kept = [r for r in rows
                if self._match_device(r, names, sigs)
                and ((r.get("total_wh") or 0) > 0 or r.get("end_time") is None)]
        # 与 get_sessions 同序：活跃优先，再按开始时间倒序
        kept.sort(key=lambda r: (0 if r.get("end_time") is None else 1,
                                 -(r.get("start_time") or 0)))
        total = len(kept)
        for r in kept:
            r.pop("_sig", None)
        return kept[offset:offset + limit], total

    def get_energy_stats_filtered(self, period: str, port: Optional[int],
                                  device_names, *,
                                  device_id: str = DEFAULT_DEVICE_ID) -> dict:
        """设备筛选版的能量统计（get_energy_stats 的形状，Python 侧聚合）。"""
        empty = {"period": period, "total_wh": 0, "session_count": 0,
                 "avg_power_w": 0, "peak_power_w": 0, "total_duration_sec": 0,
                 "by_port": {}}
        if not self._conn:
            return empty
        names = {str(n).strip() for n in (device_names or []) if str(n).strip()}
        if not names:
            return self.get_energy_stats(period, device_id=device_id, port=port)
        with self._db_lock:
            self._flush_pending()
            rows = self._attach_sig(self._sessions_in_period(
                period, port, device_id=device_id, include_active=False))
        labels = self.get_device_labels()
        sigs = {sig for sig, l in labels.items() if (l.get("name") or "") in names}
        kept = [r for r in rows
                if self._match_device(r, names, sigs) and (r.get("total_wh") or 0) > 0]
        total_wh = sum(float(r.get("total_wh") or 0) for r in kept)
        total_dur = sum(int(r.get("duration_sec") or 0) for r in kept)
        peak = max((float(r.get("peak_power_w") or 0) for r in kept), default=0)
        by_port: dict = {}
        for r in kept:
            key = str(r.get("port"))
            ent = by_port.setdefault(key, {"wh": 0.0, "count": 0})
            ent["wh"] = round(ent["wh"] + float(r.get("total_wh") or 0), 2)
            ent["count"] += 1
        return {
            "period": period,
            "total_wh": round(total_wh, 2),
            "session_count": len(kept),
            "avg_power_w": round(total_wh / (total_dur / 3600), 1) if total_dur > 0 else 0,
            "peak_power_w": round(peak, 1),
            "total_duration_sec": total_dur,
            "by_port": by_port,
        }

    def get_session_filter_options(self, period: str = "today", *,
                                   device_id: str = DEFAULT_DEVICE_ID) -> dict:
        """前端筛选下拉的可选项：周期内出现过的端口与设备名。

        设备名 = 会话行上的 device_name ∪ 签名命中标记的名字；纯"推测"的
        设备没有名字，不进下拉（用户没法按一个猜测值筛选）。
        """
        if not self._conn:
            return {"ports": [], "devices": []}
        with self._db_lock:
            self._flush_pending()
            rows = self._attach_sig(self._sessions_in_period(
                period, None, device_id=device_id, include_active=True))
        labels = self.get_device_labels()
        devices = set()
        for r in rows:
            name = (r.get("device_name") or "").strip()
            if not name:
                lab = labels.get(r.get("_sig") or "")
                name = (lab.get("name") or "").strip() if lab else ""
            if name:
                devices.add(name)
        ports = sorted({r["port"] for r in rows if r.get("port")})
        return {"ports": ports, "devices": sorted(devices)}

    def get_sessions(self, port: Optional[int] = None, period: str = "today",
                     limit: int = 10, offset: int = 0, *,
                     device_id: str = DEFAULT_DEVICE_ID) -> tuple:
        """Query charge sessions（只返回 `device_id` 名下的会话）。"""
        if not self._conn:
            return [], 0

        now = time.time()
        if period == "today":
            from datetime import datetime
            cutoff = datetime.now().replace(hour=0, minute=0, second=0).timestamp()
        elif period == "yesterday":
            from datetime import datetime
            today_start = datetime.now().replace(hour=0, minute=0, second=0).timestamp()
            cutoff = today_start - 86400
            limit_end = today_start
        elif period == "week":
            cutoff = now - 7 * 86400
        elif period == "month":
            cutoff = now - 30 * 86400
        else:
            cutoff = 0

        query = """SELECT id, port, start_time, end_time, total_wh, avg_power_w,
                   peak_power_w, avg_voltage, avg_current, duration_sec, protocol,
                   min_power_w, max_voltage, protocols, device_name,
                   start_pct, cap_wh, pct_wh,
                   COUNT(*) OVER() AS total
                   FROM charge_sessions
                   WHERE start_time >= ? AND (total_wh > 0 OR end_time IS NULL)
                     AND device_id = ?"""
        params = [cutoff, device_id]

        if port is not None:
            query += " AND port = ?"
            params.append(port)

        if period == "yesterday":
            query += " AND start_time < ?"
            params.append(limit_end)

        query += " ORDER BY end_time IS NULL DESC, start_time DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])

        rows = self._conn.execute(query, params).fetchall()
        total = rows[0]["total"] if rows else 0

        return [dict(row) for row in rows], total

    def get_session(self, session_id: int, *, device_id: Optional[str] = None) -> Optional[dict]:
        """单个会话行（详情浮层用）。

        长期供电会话不保存曲线点，但会话统计照常落库，因此详情要能单独取回这一行。

        `device_id` 非 None 时校验归属，不匹配按"不存在"返回 None（§3.9：会话级读
        也必须校验，否则 `/api/device/desk/sessions/<primary 的 id>` 能越权读到
        primary 的历史）。
        """
        if not self._conn:
            return None
        # flush + 查询必须同一把锁内完成：本方法与 get_session_points 一样会被
        # handle_session_points 在 executor 线程上调用，与 record_charge_point 的
        # 写并发访问同一条 sqlite 连接（check_same_thread=False）。只锁住 flush
        # 的话，紧接着的 SELECT 仍可能读到写事务的中间态。
        sql = """SELECT id, port, start_time, end_time, total_wh, avg_power_w,
                          peak_power_w, avg_voltage, avg_current, duration_sec, protocol,
                          min_power_w, max_voltage, protocols, device_name,
                          start_pct, cap_wh, pct_wh
                   FROM charge_sessions WHERE id = ?"""
        params: tuple = (session_id,)
        if device_id is not None:
            # 归属校验放进 WHERE 而不是取回来再比对：返回的 dict 形状必须与加列前
            # 完全一致（`/api/sessions` 会把它直接透给前端，多一个 device_id 就是
            # 外部可见变化，见 §3.8）。
            sql += " AND device_id = ?"
            params = (session_id, device_id)
        with self._db_lock:
            self._flush_pending()   # 缓冲中的点要先落盘，否则详情取不到最近几秒
            row = self._conn.execute(sql, params).fetchone()
        return dict(row) if row else None

    # ── 设备标记：按"充电签名"记住这是哪台设备 ──
    #
    # 充电器只能读到每个口的 V/A 与协议，**拿不到品牌型号**（PD/PPS 协议本身
    # 不传设备标识）。所以这里用"签名"当指纹：同档位功率 + 同电压 + 同协议组合
    # 视为同一类设备，用户标记一次后，之后同签名的会话自动套用这个名字。
    # 签名规则见 device_ident.py:signature()。

    def get_device_labels(self) -> dict:
        """返回 {signature: {name, cls, sample_session_id, updated_at}}。"""
        if not self._conn:
            return {}
        with self._db_lock:
            try:
                rows = self._conn.execute(
                    """SELECT signature, name, cls, sample_session_id, updated_at
                       FROM device_labels""").fetchall()
            except Exception as e:
                _LOGGER.error("Failed to read device labels: %s", e)
                return {}
        return {r["signature"]: dict(r) for r in rows}

    def upsert_device_label(self, signature: str, name: str, cls: str = "",
                            sample_session_id: Optional[int] = None) -> None:
        """写入/覆盖一个设备标记（name 为空视为清除）。"""
        if not self._conn or not signature:
            return
        name = (name or "").strip()
        if not name:
            self.delete_device_label(signature)
            return
        with self._db_lock:
            try:
                self._conn.execute(
                    """INSERT INTO device_labels
                           (signature, name, cls, sample_session_id, updated_at)
                       VALUES (?, ?, ?, ?, ?)
                       ON CONFLICT(signature) DO UPDATE SET
                           name = excluded.name,
                           cls = excluded.cls,
                           sample_session_id = excluded.sample_session_id,
                           updated_at = excluded.updated_at""",
                    (signature, name[:60], (cls or "")[:20],
                     sample_session_id, time.time()))
                self._conn.commit()
            except Exception as e:
                _LOGGER.error("Failed to upsert device label: %s", e)

    def delete_device_label(self, signature: str) -> None:
        if not self._conn or not signature:
            return
        with self._db_lock:
            try:
                self._conn.execute(
                    "DELETE FROM device_labels WHERE signature = ?", (signature,))
                self._conn.commit()
            except Exception as e:
                _LOGGER.error("Failed to delete device label: %s", e)

    # ── 电池档案：同一台设备的"品牌 / 型号 / 容量"填一次就够 ──
    #
    # 用充电签名当主键（与设备标记同一把指纹），所以"电池容量"和"设备名字"
    # 天然是同一条记录的两种属性：标记过一次名字的笔记本，下次插上来容量也
    # 已经在了，用户只需要填当前电量。

    def get_battery_profiles(self) -> dict:
        """返回 {signature: {brand, model, cap_wh, cap_mah, updated_at}}。"""
        if not self._conn:
            return {}
        with self._db_lock:
            try:
                rows = self._conn.execute(
                    """SELECT signature, brand, model, cap_wh, cap_mah, updated_at
                       FROM battery_profiles""").fetchall()
            except Exception as e:
                _LOGGER.error("Failed to read battery profiles: %s", e)
                return {}
        return {r["signature"]: dict(r) for r in rows}

    def get_battery_profile(self, signature: str) -> Optional[dict]:
        if not self._conn or not signature:
            return None
        with self._db_lock:
            row = self._conn.execute(
                """SELECT signature, brand, model, cap_wh, cap_mah, updated_at
                   FROM battery_profiles WHERE signature = ?""", (signature,)).fetchone()
        return dict(row) if row else None

    def set_session_battery(self, session_id: int, *,
                            start_pct: Optional[float] = None,
                            cap_wh: Optional[float] = None,
                            brand: str = "", model: str = "",
                            cap_mah: Optional[float] = None,
                            signature: str = "",
                            pct_wh: Optional[float] = None,
                            clear: bool = False) -> None:
        """把"这次充电从多少 % 开始 + 电池容量"写进会话行，并按签名存一份档案。

        start_pct / cap_wh 落在会话行上：这一次充了多少是既成事实，之后改档案
        不能把历史记录改掉。档案（battery_profiles）只是下一次的默认值。

        start_pct 允许单独更新（用户只改电量不动容量时），None 表示"这项不动"。
        `clear=True` 把两列清空（用户想撤掉这次填的电量口径）。
        """
        if not self._conn or not session_id:
            return
        sets, params = [], []
        if clear:
            sets.extend(["start_pct = NULL", "cap_wh = NULL", "pct_wh = 0"])
        if start_pct is not None:
            sets.append("start_pct = ?")
            params.append(max(0.0, min(100.0, float(start_pct))))
            if pct_wh is not None:
                sets.append("pct_wh = ?")
                params.append(max(0.0, float(pct_wh)))
        if cap_wh is not None and float(cap_wh) > 0:
            sets.append("cap_wh = ?")
            params.append(float(cap_wh))
        if sets:
            params.append(session_id)
            with self._db_lock:
                try:
                    self._conn.execute(
                        f"UPDATE charge_sessions SET {', '.join(sets)} WHERE id = ?",
                        tuple(params))
                    self._conn.commit()
                except Exception as e:
                    _LOGGER.error("Failed to set battery for session %s: %s",
                                  session_id, e)
        # 已结束的会话补填电量 → 曲线学习挪到档案 upsert 之后（按签名才能
        # 取到刚写的品牌/型号）；充电中的会话在 end_session 收尾时学。
        if not signature:
            return
        if not (cap_wh and float(cap_wh) > 0) and not (brand or model):
            return
        with self._db_lock:
            try:
                self._conn.execute(
                    """INSERT INTO battery_profiles
                           (signature, brand, model, cap_wh, cap_mah, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?)
                       ON CONFLICT(signature) DO UPDATE SET
                           brand = CASE WHEN excluded.brand <> '' THEN excluded.brand
                                        ELSE battery_profiles.brand END,
                           model = CASE WHEN excluded.model <> '' THEN excluded.model
                                        ELSE battery_profiles.model END,
                           cap_wh = CASE WHEN excluded.cap_wh > 0 THEN excluded.cap_wh
                                         ELSE battery_profiles.cap_wh END,
                           cap_mah = CASE WHEN excluded.cap_mah > 0 THEN excluded.cap_mah
                                          ELSE battery_profiles.cap_mah END,
                           updated_at = excluded.updated_at""",
                    (signature, (brand or "")[:40], (model or "")[:60],
                     float(cap_wh or 0), float(cap_mah or 0), time.time()))
                self._conn.commit()
            except Exception as e:
                _LOGGER.error("Failed to upsert battery profile %s: %s", signature, e)
        # 已结束的会话补填/改电量：档案刚写好，现在做一次曲线学习
        # （充电中的会话不在这里学，end_session 收尾时会统一学）
        if start_pct is not None:
            try:
                with self._db_lock:
                    r = self._conn.execute(
                        "SELECT end_time FROM charge_sessions WHERE id = ?",
                        (session_id,)).fetchone()
                if r and r["end_time"]:
                    self.learn_session_curve(session_id)
            except Exception as e:
                _LOGGER.error("Failed to learn curve after battery save %s: %s",
                              session_id, e)

    def delete_battery_profile(self, signature: str) -> None:
        if not self._conn or not signature:
            return
        with self._db_lock:
            try:
                self._conn.execute(
                    "DELETE FROM battery_profiles WHERE signature = ?", (signature,))
                self._conn.commit()
            except Exception as e:
                _LOGGER.error("Failed to delete battery profile: %s", e)

    # ── 充电曲线学习：把每台设备实测的 SOC-功率曲线按型号归档 ──
    #
    # 默认衰减表来自公开实测，但每台设备的真实表现受温度、线材、电池健康度、
    # 系统充电策略影响。做法：会话结束后逐采样点反推 SOC
    # （起点电量 + 已充输出能量 × 转换效率 / 容量），归入 LEARN_BANDS 区间累计
    # 能量与耗时 → 实测平均功率 / 会话峰值 = 该段比例；与已存曲线做 EMA 融合
    # （学习次数越多，单次会话的影响越小）。归档 key 与设备标记一样"跨口共享"：
    # 同一台设备插 C1 或 C2 都命中同一条曲线。

    CH_EFF = 0.88
    LEARN_BANDS = [0, 50, 70, 75, 80, 90, 95, 100]

    def get_learn_curves(self) -> dict:
        """返回 {model_key: {curve: [[lo, ratio]...], n, peak_w, updated_at}}。"""
        if not self._conn:
            return {}
        with self._db_lock:
            try:
                rows = self._conn.execute(
                    "SELECT model_key, curve, n, peak_w, updated_at FROM learn_curves"
                ).fetchall()
            except Exception as e:
                _LOGGER.error("Failed to read learn curves: %s", e)
                return {}
        out = {}
        for r in rows:
            try:
                out[r["model_key"]] = {
                    "curve": json.loads(r["curve"]),
                    "n": int(r["n"] or 0),
                    "peak_w": r["peak_w"] or 0,
                    "updated_at": r["updated_at"],
                }
            except Exception:
                continue
        return out

    @staticmethod
    def _learn_model_key(profile: Optional[dict]) -> str:
        """学习归档 key：电池档案里的「品牌+型号」，与前端 _learnModelKey 对齐。"""
        if not profile:
            return ""
        model = str(profile.get("model") or "").strip()
        if not model:
            return ""
        brand = str(profile.get("brand") or "").strip()
        if brand and brand not in model:
            return f"{brand} {model}"
        return model

    def learn_session_curve(self, session_id: int) -> bool:
        """把一段会话的实测充电曲线按型号归档。

        触发点：end_session（充电中填过电量 → 收尾时学）与已结束会话补填电量
        （set_session_battery）。前提：填过起始电量（≥5 且 <100）与容量、有
        足够采样点、会话峰值 ≥3W。归档 key 优先电池档案的品牌+型号，没有档案
        时回落会话设备名（用户标记的名字，往往就是型号）。
        """
        if not self._conn or not session_id:
            return False
        with self._db_lock:
            try:
                row = self._conn.execute(
                    """SELECT start_pct, cap_wh, pct_wh, peak_power_w,
                              protocol, max_voltage, protocols, device_name
                       FROM charge_sessions WHERE id = ?""", (session_id,)).fetchone()
            except Exception as e:
                _LOGGER.error("Failed to load session %s: %s", session_id, e)
                return False
        if not row:
            return False
        start_pct = row["start_pct"]
        cap_wh = row["cap_wh"]
        if start_pct is None or not cap_wh or cap_wh <= 0:
            return False
        if start_pct < 5 or start_pct >= 100:
            return False
        with self._db_lock:
            self._flush_pending()
            pts = self._conn.execute(
                """SELECT timestamp, power FROM charge_points
                   WHERE session_id = ? ORDER BY timestamp""",
                (session_id,)).fetchall()
        if len(pts) < 3:
            return False
        peak = row["peak_power_w"] or 0
        if peak < 3:
            peak = max((p["power"] or 0.0) for p in pts)
        if peak < 3:
            return False

        # 归档 key：签名 → 电池档案的品牌/型号；没有档案回落会话设备名
        model_key = ""
        if _device_signature is not None:
            try:
                sig = _device_signature({
                    "protocol": row["protocol"],
                    "peak_power_w": row["peak_power_w"],
                    "max_voltage": row["max_voltage"],
                    "protocols": row["protocols"],
                })
                model_key = self._learn_model_key(self.get_battery_profile(sig))
            except Exception:
                pass
        if not model_key:
            model_key = (row["device_name"] or "").strip()
        if not model_key:
            return False

        # pct_wh = 填电量那一刻已经充进去的 Wh，反推 SOC 时要扣掉，
        # 否则"充了半小时才填 42%"会把前半段重复计入
        base = max(0.0, row["pct_wh"] or 0.0)
        acc: dict = {}
        cum = 0.0
        for i in range(1, len(pts)):
            dt = pts[i]["timestamp"] - pts[i - 1]["timestamp"]
            if dt <= 0 or dt > 120:
                continue
            p0 = pts[i - 1]["power"] or 0.0
            p1 = pts[i]["power"] or 0.0
            e = (p0 + p1) / 2 * dt / 3600.0
            soc_lo = start_pct + (cum - base) * self.CH_EFF / cap_wh * 100.0
            cum += e
            soc_hi = start_pct + (cum - base) * self.CH_EFF / cap_wh * 100.0
            if soc_hi <= soc_lo:
                continue   # 这段时间没充进电（拔出/暂停），不归属区间
            mid = (soc_lo + soc_hi) / 2
            for bi in range(len(self.LEARN_BANDS) - 1):
                if self.LEARN_BANDS[bi] <= mid < self.LEARN_BANDS[bi + 1]:
                    slot = acc.setdefault(self.LEARN_BANDS[bi], [0.0, 0.0])
                    slot[0] += e
                    slot[1] += dt
                    break

        existing = self.get_learn_curves().get(model_key) or {}
        old_map = {}
        for c in (existing.get("curve") or []):
            if isinstance(c, list) and len(c) >= 2:
                old_map[c[0]] = float(c[1])
        n_old = int(existing.get("n") or 0)

        learned = 0
        w_new = 1.0 / (n_old + 1)
        merged = dict(old_map)
        for lo, (wh, sec) in acc.items():
            if sec < 60:
                continue   # 区间数据太短不可信
            ratio = min(1.2, max(0.03, (wh / sec * 3600.0) / peak))
            prev = old_map.get(lo)
            # EMA：越多次会话，单次的影响越小
            merged[lo] = ratio if prev is None else prev * (1 - w_new) + ratio * w_new
            learned += 1
        if not learned:
            return False

        curve_out = sorted([lo, round(r, 3)] for lo, r in merged.items())
        with self._db_lock:
            try:
                self._conn.execute(
                    """INSERT INTO learn_curves (model_key, curve, n, peak_w, updated_at)
                       VALUES (?, ?, ?, ?, ?)
                       ON CONFLICT(model_key) DO UPDATE SET
                           curve = excluded.curve, n = excluded.n,
                           peak_w = excluded.peak_w, updated_at = excluded.updated_at""",
                    (model_key, json.dumps(curve_out), n_old + 1,
                     round(peak, 1), time.time()))
                # 只留最近 50 台设备的曲线，防表膨胀
                keys = self._conn.execute(
                    "SELECT model_key FROM learn_curves ORDER BY updated_at DESC"
                ).fetchall()
                for k in keys[50:]:
                    self._conn.execute(
                        "DELETE FROM learn_curves WHERE model_key = ?",
                        (k["model_key"],))
                self._conn.commit()
            except Exception as e:
                _LOGGER.error("Failed to store learn curve for %s: %s", model_key, e)
                return False
        _LOGGER.info("Learned charge curve for %s (%d bands, session %s)",
                     model_key, learned, session_id)
        return True

    def get_session_points(self, session_id: int, *,
                           device_id: Optional[str] = None) -> list[dict]:
        """Get all data points for a charge session.

        归属校验同 get_session：先确认会话属于该设备，否则返回空列表。
        """
        if not self._conn:
            return []
        # 同上：flush 与 SELECT 必须在同一把锁内，否则能读到写事务中间态。
        with self._db_lock:
            self._flush_pending()   # 缓冲中的点要先落盘，否则详情图会缺最近几秒
            if device_id is not None:
                owner = self._conn.execute(
                    "SELECT device_id FROM charge_sessions WHERE id = ?",
                    (session_id,)).fetchone()
                if not owner or owner["device_id"] != device_id:
                    return []
            rows = self._conn.execute(
                """SELECT timestamp, voltage, current, power, protocol
                   FROM charge_points WHERE session_id = ?
                   ORDER BY timestamp""",
                (session_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    @staticmethod
    def _period_window(period: str):
        """把周期名换算成 [start, end) 时间窗；end=None 表示"到此刻为止"。

        口径说明：today / yesterday 是自然日；week / month 是**滚动** 7 / 30 天，
        不是自然周 / 自然月——前端的文案因此写"近 7 天 / 近 30 天"，两者必须一致。
        """
        midnight = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        if period == "today":
            return midnight.timestamp(), None
        if period == "yesterday":
            return midnight.timestamp() - 86400, midnight.timestamp()
        if period == "week":
            return time.time() - 7 * 86400, None
        if period == "month":
            return time.time() - 30 * 86400, None
        return 0.0, None

    def get_energy_stats(self, period: str = "today", *,
                         device_id: str = DEFAULT_DEVICE_ID,
                         port: Optional[int] = None) -> dict:
        """Get aggregated energy statistics（只统计该设备名下的会话）。

        `port` 非 None 时只统计该端口（前端"端口筛选"用），统计口径其余不变。
        """
        if not self._conn:
            return {"period": period, "total_wh": 0, "session_count": 0}

        start, end = self._period_window(period)
        where = ("start_time >= ?"
                 + (" AND start_time < ?" if end is not None else "")
                 + " AND device_id = ?")
        params: list = ([start] if end is None else [start, end]) + [device_id]
        if port is not None:
            where += " AND port = ?"
            params.append(port)

        row = self._conn.execute(
            f"""SELECT
                COUNT(*) as session_count,
                COALESCE(SUM(total_wh), 0) as total_wh,
                COALESCE(MAX(peak_power_w), 0) as peak_power_w,
                COALESCE(SUM(duration_sec), 0) as total_duration_sec
            FROM charge_sessions WHERE {where} AND total_wh > 0""",
            params,
        ).fetchone()

        by_port = self._conn.execute(
            f"""SELECT port, COALESCE(SUM(total_wh), 0) as wh, COUNT(*) as count
               FROM charge_sessions WHERE {where} AND total_wh > 0
               GROUP BY port""",
            params,
        ).fetchall()

        # Calculate avg power from total energy and duration (more accurate than DB avg)
        total_dur = row["total_duration_sec"] or 0
        total_wh = row["total_wh"] or 0
        avg_power = round(total_wh / (total_dur / 3600), 1) if total_dur > 0 else 0

        return {
            "period": period,
            "total_wh": round(total_wh, 2),
            "session_count": row["session_count"],
            "avg_power_w": avg_power,
            "peak_power_w": round(row["peak_power_w"], 1),
            "total_duration_sec": total_dur,
            "by_port": {str(r["port"]): {"wh": round(r["wh"], 2), "count": r["count"]}
                        for r in by_port},
        }

    def get_protocol_stats(self, period: str = "today", *,
                           device_id: str = DEFAULT_DEVICE_ID) -> dict:
        """按充电协议聚合电量与会话数（"快充到底跑没跑上"）。

        口径与 get_energy_stats 完全一致（同一个 _period_window），所以卡片上两个
        视图的合计值能对上。历史记录里 protocol 可能为空（早于该列存在），
        统一归到 'unknown' 而不是丢掉——否则各协议之和对不上总量。
        """
        if not self._conn:
            return {"period": period, "protocols": [], "total_wh": 0, "session_count": 0}

        start, end = self._period_window(period)
        where = "start_time >= ?" + (" AND start_time < ?" if end is not None else "") + " AND device_id = ?"
        params = ([start] if end is None else [start, end]) + [device_id]

        rows = self._conn.execute(
            f"""SELECT COALESCE(NULLIF(TRIM(protocol), ''), 'unknown') AS proto,
                       COALESCE(SUM(total_wh), 0) AS wh,
                       COUNT(*) AS count,
                       COALESCE(MAX(peak_power_w), 0) AS peak_w
                FROM charge_sessions WHERE {where} AND total_wh > 0
                GROUP BY proto ORDER BY wh DESC""",
            params,
        ).fetchall()

        protocols = [
            {"protocol": r["proto"], "wh": round(r["wh"], 2),
             "count": r["count"], "peak_w": round(r["peak_w"], 1)}
            for r in rows
        ]
        return {
            "period": period,
            "protocols": protocols,
            "total_wh": round(sum(p["wh"] for p in protocols), 2),
            "session_count": sum(p["count"] for p in protocols),
        }


class DeviceHistory:
    """共享 `PortHistory` 的**按设备视图**（设计文档 §3.2）。

    存在理由：`BLEManager` 有 12 处 `self._history.*` 写入、`Server` 有 16 处
    `self.history.*` 调用，签名全部保持"无 device 参数"的样子——由本 facade 在内部
    代填 `device_id`。这样两个调用方一行不改，也不会串设备。

    两条纪律：

    1. **显式白名单，不用 `__getattr__` 兜底**。P0-1 的失败模式就是"漏了一项装配、
       而且静默"：隐式代理会让"忘了给某个写入带 device_id"变成一个永远不会被发现的
       bug（写进 default 行，界面上看起来只是"历史少了一段"）。写清单意味着新增
       PortHistory 方法时这里会 AttributeError，逼人做决定。
    2. **不代理连接生命周期**。`connect()/close()/flush()` 属于共享 store，绝不能
       经某台设备的视图去关——`close_all()` 关闭共享连接会顺手掐掉其它设备。
       服务级 meta（`web_language`）同理不经此视图（§3.9）。
    """

    __slots__ = ("store", "device_id")

    def __init__(self, store: "PortHistory", device_id: str = DEFAULT_DEVICE_ID):
        self.store = store
        self.device_id = device_id or DEFAULT_DEVICE_ID

    # ── 采样写入 / 查询（设备维度）──
    def record_port_data(self, port: int, data: dict):
        return self.store.record_port_data(port, data, device_id=self.device_id)

    def query_history(self, port: int, hours: int = 24, interval: Optional[int] = None):
        return self.store.query_history(port, hours, interval, device_id=self.device_id)

    def query_history_multi(self, start_port: int, end_port: int, hours: float, interval: int):
        return self.store.query_history_multi(
            start_port, end_port, hours, interval, device_id=self.device_id)

    def get_statistics(self, port: int, hours: int = 24):
        return self.store.get_statistics(port, hours, device_id=self.device_id)

    def export_csv(self, port: int, hours: int = 24):
        return self.store.export_csv(port, hours, device_id=self.device_id)

    # ── 会话（设备维度）──
    def start_session(self, port: int, protocol: str = "",
                      start_time: Optional[float] = None) -> int:
        return self.store.start_session(port, protocol, start_time,
                                        device_id=self.device_id)

    def get_sessions(self, port: Optional[int] = None, period: str = "today",
                     limit: int = 10, offset: int = 0):
        return self.store.get_sessions(port, period, limit, offset,
                                       device_id=self.device_id)

    def get_energy_stats(self, period: str = "today", port=None) -> dict:
        return self.store.get_energy_stats(period, device_id=self.device_id, port=port)

    def get_protocol_stats(self, period: str = "today"):
        return self.store.get_protocol_stats(period, device_id=self.device_id)

    def close_stale_sessions(self) -> int:
        """只收本设备的遗留会话（store.connect() 里的那个是 None=全设备）。"""
        return self.store.close_stale_sessions(self.device_id)

    # ── 会话级读：带归属校验（§3.9 越权读）──
    def get_session(self, session_id: int):
        return self.store.get_session(session_id, device_id=self.device_id)

    def get_session_points(self, session_id: int):
        return self.store.get_session_points(session_id, device_id=self.device_id)

    def export_session_csv(self, session_id: int):
        return self.store.export_session_csv(session_id, device_id=self.device_id)

    # ── 会话级写：sid 已锁定归属，不再校验（传 None 的语义同 PortHistory）──
    def record_charge_point(self, session_id: int, voltage: float,
                            current: float, power: float, protocol: str = ""):
        return self.store.record_charge_point(session_id, voltage, current, power, protocol)

    def record_charge_points(self, session_id: int, rows) -> int:
        return self.store.record_charge_points(session_id, rows)

    def end_session(self, session_id: int, total_wh: float, peak_power_w: float,
                    avg_voltage: float, avg_current: float, duration_sec: int,
                    end_time: Optional[float] = None):
        return self.store.end_session(session_id, total_wh, peak_power_w,
                                      avg_voltage, avg_current, duration_sec, end_time)

    def delete_session(self, session_id: int):
        return self.store.delete_session(session_id)

    def delete_sessions(self, session_ids) -> int:
        return self.store.delete_sessions(session_ids, device_id=self.device_id)

    def clear_sessions(self) -> int:
        return self.store.clear_sessions(device_id=self.device_id)

    def get_session_filter_options(self, period: str = "today") -> dict:
        return self.store.get_session_filter_options(period, device_id=self.device_id)

    def get_sessions_filtered(self, port=None, period: str = "today",
                              device_names=None, limit: int = 10, offset: int = 0) -> tuple:
        return self.store.get_sessions_filtered(port, period, device_names,
                                                limit, offset, device_id=self.device_id)

    def get_energy_stats_filtered(self, period: str = "today", port=None,
                                  device_names=None) -> dict:
        return self.store.get_energy_stats_filtered(period, port, device_names,
                                                    device_id=self.device_id)

    def set_session_device_name(self, session_id: int, name: str) -> None:
        return self.store.set_session_device_name(session_id, name)

    def compute_session_avg_vi(self, session_id: int) -> tuple:
        return self.store.compute_session_avg_vi(session_id)

    def compute_session_totals(self, session_id: int) -> tuple:
        return self.store.compute_session_totals(session_id)

    def compute_session_extras(self, session_id: int) -> tuple:
        return self.store.compute_session_extras(session_id)

    # ── 设备标记（**跨设备共享**，故意不带 device_id）──
    # 签名描述的是"插在这一台上的那台设备"（手机/笔记本），与充电器属于哪个
    # device_id 无关；同一台笔记本插在 C1 或 C2 上应当认成同一台。
    def get_device_labels(self) -> dict:
        return self.store.get_device_labels()

    def upsert_device_label(self, signature: str, name: str, cls: str = "",
                            sample_session_id: Optional[int] = None) -> None:
        return self.store.upsert_device_label(signature, name, cls, sample_session_id)

    def delete_device_label(self, signature: str) -> None:
        return self.store.delete_device_label(signature)

    # ── 电池档案（同样跨设备共享）──
    def get_battery_profiles(self) -> dict:
        return self.store.get_battery_profiles()

    def get_battery_profile(self, signature: str) -> Optional[dict]:
        return self.store.get_battery_profile(signature)

    def set_session_battery(self, session_id: int, **kwargs) -> None:
        return self.store.set_session_battery(session_id, **kwargs)

    def delete_battery_profile(self, signature: str) -> None:
        return self.store.delete_battery_profile(signature)

    # ── 充电曲线学习（跨设备共享，与电池档案同一归档口径）──
    def get_learn_curves(self) -> dict:
        return self.store.get_learn_curves()

    def learn_session_curve(self, session_id: int) -> bool:
        return self.store.learn_session_curve(session_id)

    # ── 设备级 meta（§3.9：非 primary 走 `{id}:{key}` 命名空间）──
    def get_session_recording(self) -> bool:
        return self.store.get_session_recording(device_id=self.device_id)

    def set_session_recording(self, enabled: bool) -> None:
        return self.store.set_session_recording(enabled, device_id=self.device_id)

    def get_permanent_ports(self) -> list:
        return self.store.get_permanent_ports(device_id=self.device_id)

    def set_permanent_ports(self, names) -> list:
        return self.store.set_permanent_ports(names, device_id=self.device_id)

    def get_full_off(self) -> dict:
        return self.store.get_full_off(device_id=self.device_id)

    def set_full_off(self, entries) -> dict:
        return self.store.set_full_off(entries, device_id=self.device_id)

    def get_charge_limits(self) -> dict:
        return self.store.get_charge_limits(device_id=self.device_id)

    def set_charge_limits(self, limits: dict) -> None:
        return self.store.set_charge_limits(limits, device_id=self.device_id)

    # ── 缓冲区可见性（只读触发，不拥有缓冲）──
    def flush(self) -> None:
        return self.store.flush()

    def __repr__(self) -> str:  # 日志/断言里能看出是哪个设备的视图
        return f"<DeviceHistory device_id={self.device_id!r} store={id(self.store):#x}>"
