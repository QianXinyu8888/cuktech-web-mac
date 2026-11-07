"""兼容命令行入口：请先安装环境，日常双击「启动助手.command」。"""
from macos.launcher import main

if __name__ == "__main__":
    raise SystemExit(main())
