"""配置页"删除任意充电器"的服务端回归（§3.10 / §3.12）。

前端只保证"删掉主设备后下一张卡自动顶上"，但有两个不变式只能由服务端守住：

1. 被提升的那台原本是 `devices:` 里的附加设备，页面**永远拿不到它的明文凭据**
   （/api/config 打码、/api/devices 不带）。若服务端不按 `primary_credential_source`
   从旧 YAML 继承，空串会覆盖掉真实 token：凭据不可逆地丢失，重启还会被
   `validate_device_specs` 以"primary 必须在 ble: 节配置"拒绝启动，Web UI 一起消失。
2. 删到一台不剩也必须能落盘并重新解析（清空 `ble:` 节），不能留下一个带着旧
   MAC/token 的幽灵设备继续扫蓝牙。

另外锁住一条容易复发的事故：旧的"自动把第一台附加设备提升为 primary"兜底
补丁，在新前端已经显式提升过卡片时**绝不能**再跑——它会把剩余的第一台附加
设备当成提升对象，把 B 的 token 装到 A 上。
"""
import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))

from config import config_from_mapping, load_config  # noqa: E402
from golden_harness import golden_env, mock_request  # noqa: E402

PRIMARY_MAC = "AA:BB:CC:DD:EE:01"
DESK_MAC = "AA:BB:CC:DD:EE:02"
BED_MAC = "AA:BB:CC:DD:EE:03"
PRIMARY_TOKEN = "00" * 16
DESK_TOKEN = "11" * 16
BED_TOKEN = "22" * 16


def _write_config(path, bemfa_entities=None):
    doc = {
        "ble": {"mac": PRIMARY_MAC, "token": PRIMARY_TOKEN,
                "ble_key": "key-primary", "name": "客厅主充"},
        "devices": [
            {"id": "desk", "name": "书桌", "mac": DESK_MAC, "token": DESK_TOKEN,
             "ble_key": "key-desk"},
            {"id": "bed", "name": "卧室", "mac": BED_MAC, "token": BED_TOKEN},
        ],
    }
    if bemfa_entities is not None:
        doc["bemfa"] = {"enabled": False, "entities": bemfa_entities}
    path.write_text(yaml.safe_dump(doc, allow_unicode=True), encoding="utf-8")


class TestRemoveChargerConfigSave:
    @pytest.fixture
    async def env(self, tmp_path, monkeypatch):
        cfg_path = tmp_path / "config.yaml"
        _write_config(cfg_path)
        async with golden_env(devices=[
            {"id": "desk", "mac": DESK_MAC, "token": DESK_TOKEN},
            {"id": "bed", "mac": BED_MAC, "token": BED_TOKEN},
        ]) as e:
            monkeypatch.setattr(e.server, "_config_path", lambda: cfg_path)

            async def _no_restart():
                return None
            monkeypatch.setattr(e.server, "_delayed_restart", _no_restart)
            # golden_env 给的是 GoldenEnv 包装对象；handler 挂在 .server 上
            yield e.server, cfg_path

    async def _save(self, server, payload):
        req = mock_request("POST", "/api/config")

        async def _json():
            return payload
        req.json = _json
        return await server.handle_config_save(req)

    async def test_promotion_inherits_credentials_from_old_extra(self, env):
        """删掉主设备、desk 顶上：token/ble_key 必须来自旧 devices.desk。"""
        server, cfg_path = env
        payload = {
            "config": {
                # 页面拿不到附加设备的明文 → token/ble_key 是空串
                "ble": {"mac": DESK_MAC, "token": "", "ble_key": "", "name": "书桌"},
                "devices": [{"id": "bed", "name": "卧室", "mac": BED_MAC,
                             "token": "", "ble_key": "", "topic_prefix": ""}],
            },
            "primary_credential_source": "desk",
        }
        resp = await self._save(server, payload)
        assert resp.status == 200, resp.body

        saved = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
        assert saved["ble"]["mac"] == DESK_MAC
        assert saved["ble"]["token"] == DESK_TOKEN, "旧 desk 的 token 不能被空串覆盖"
        assert saved["ble"]["ble_key"] == "key-desk", "BLE Key 同样要继承"
        assert saved["ble"]["name"] == "书桌", "旧 primary 的名字不能留给新 primary"
        by_id = {d["id"]: d for d in saved["devices"]}
        assert set(by_id) == {"bed"}, "desk 已经提升，不能再留在 devices: 节"
        assert by_id["bed"]["token"] == BED_TOKEN, "剩余附加设备照旧按 id 继承"
        # 旧兜底补丁若误跑，会把 bed 提升进 ble:，mac 会变成 BED_MAC
        assert saved["ble"]["mac"] != BED_MAC, "显式提升后不能再跑旧的自动提升兜底"

        cfg = load_config(cfg_path)
        specs = cfg.device_specs()
        assert [s.device_id for s in specs] == ["default", "bed"]
        assert specs[0].token == DESK_TOKEN and specs[1].token == BED_TOKEN

    async def test_deleting_all_chargers_is_savable(self, env):
        """删到一台不剩：ble: 节清空、巴法云实体表清空，配置仍能被生产解析器接受。

        盘上故意留着指向 desk/bed 的语音实体：`validate_bemfa_entities` 会在
        load_config 里 raise，若页面没有把 `bemfa.entities: []` 一起提交（或
        seedBemfaEntities 又铺回 default 的 5 行），保存必然 400 —— 这正是
        "删得干净却存不了" 的复发路径。payload 按 config.html 的真实形状发全量。
        """
        server, cfg_path = env
        _write_config(cfg_path, bemfa_entities=[
            {"name": "书桌C1", "device": "desk", "port": "c1"},
            {"name": "卧室C2", "device": "bed", "port": "c2"},
            {"name": "主充BLE", "device": "default", "port": "ble"},
        ])
        payload = {
            "config": {
                "ble": {"mac": "", "token": "", "ble_key": "", "name": ""},
                "devices": [],
                "mqtt": {"enabled": True, "host": "127.0.0.1", "port": 1883,
                         "username": "", "password": "", "topic_prefix": "cuktech/charger"},
                "bemfa": {"enabled": False, "uid": "", "entities": [],
                          "name_c1": "C1", "name_c2": "C2", "name_c3": "C3",
                          "name_a": "A", "name_ble": "蓝牙"},
                "server": {"port": 8199, "history_retention_days": 2},
            },
            "primary_credential_source": "",
        }
        resp = await self._save(server, payload)
        assert resp.status == 200, resp.body

        saved = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
        assert saved["ble"]["mac"] == "", "不能留下旧设备继续扫蓝牙"
        assert not saved["ble"].get("token"), "旧凭据必须一并清空"
        assert not saved["ble"].get("name"), "旧名字必须一并清空"
        assert "devices" not in saved or not saved["devices"]
        assert saved["bemfa"]["entities"] == [], "旧实体不能残留并指向已删设备"

        cfg = config_from_mapping(saved)
        assert len(cfg.devices) == 0
        assert cfg.ble.mac == ""
        assert cfg.bemfa.entities == []

    async def test_unchanged_primary_is_not_rewritten(self, env):
        """没删主设备时行为逐字节不变：掩码 token 不覆盖真实值，名字保持。"""
        server, cfg_path = env
        payload = {
            "config": {
                "ble": {"mac": PRIMARY_MAC, "token": "00****0000", "ble_key": "****"},
                "devices": [
                    {"id": "desk", "name": "书桌", "mac": DESK_MAC, "token": ""},
                    {"id": "bed", "name": "卧室", "mac": BED_MAC, "token": ""},
                ],
            },
            "primary_credential_source": "default",
        }
        resp = await self._save(server, payload)
        assert resp.status == 200, resp.body

        saved = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
        assert saved["ble"]["token"] == PRIMARY_TOKEN
        assert saved["ble"]["ble_key"] == "key-primary"
        assert saved["ble"]["name"] == "客厅主充"
        assert [d["id"] for d in saved["devices"]] == ["desk", "bed"]
        assert saved["devices"][0]["token"] == DESK_TOKEN

    async def test_promotion_masked_credentials_never_use_deleted_primary(self, env):
        server, cfg_path = env
        resp = await self._save(server, {
            "config": {
                "ble": {"mac": DESK_MAC, "token": "****", "ble_key": "****"},
                "devices": [{"id": "bed", "mac": BED_MAC, "token": ""}],
            }, "primary_credential_source": "desk",
        })
        assert resp.status == 200
        saved = yaml.safe_load(cfg_path.read_text())
        assert saved["ble"]["token"] == DESK_TOKEN
        assert saved["ble"]["ble_key"] == "key-desk"

    async def test_rename_preserves_extra_device_ble_key(self, env):
        server, cfg_path = env
        resp = await self._save(server, {
            "config": {
                "ble": {"mac": PRIMARY_MAC, "token": "****", "name": "主充新名字"},
                "devices": [{"id": "desk", "name": "书桌新名字", "mac": DESK_MAC,
                             "token": "", "ble_key": ""}],
            }, "primary_credential_source": "default",
        })
        assert resp.status == 200
        saved = load_config(cfg_path)
        assert saved.ble.name == "主充新名字"
        assert saved.devices[0].name == "书桌新名字"
        assert saved.devices[0].ble_key == "key-desk"

    async def test_save_keeps_credentials_private_on_disk(self, env):
        server, cfg_path = env
        cfg_path.chmod(0o600)
        resp = await self._save(server, {"config": {"ble": {"name": "新名字"}}})
        assert resp.status == 200
        assert cfg_path.stat().st_mode & 0o777 == 0o600

    async def test_renaming_primary_with_blank_secret_inputs_preserves_identity(self, env):
        server, cfg_path = env
        resp = await self._save(server, {
            "config": {
                "ble": {"mac": PRIMARY_MAC, "name": "新名称", "token": "", "ble_key": ""},
                "devices": [{"id": "desk", "mac": DESK_MAC, "token": ""},
                            {"id": "bed", "mac": BED_MAC, "token": ""}],
            }, "primary_credential_source": "default",
        })
        assert resp.status == 200
        saved = load_config(cfg_path)
        assert saved.ble.mac == PRIMARY_MAC
        assert saved.ble.token == PRIMARY_TOKEN
        assert saved.ble.ble_key == "key-primary"
        assert len(saved.devices) == 2

    async def test_editing_extra_device_id_preserves_credentials_from_source(self, env):
        server, cfg_path = env
        resp = await self._save(server, {
            "config": {"devices": [
                {"id": "office", "source_id": "desk", "name": "办公室", "mac": DESK_MAC,
                 "token": "", "ble_key": ""},
            ]}, "primary_credential_source": "default",
        })
        assert resp.status == 200
        saved = load_config(cfg_path)
        assert saved.devices[0].device_id == "office"
        assert saved.devices[0].token == DESK_TOKEN
        assert saved.devices[0].ble_key == "key-desk"
        assert "source_id" not in yaml.safe_load(cfg_path.read_text())["devices"][0]
