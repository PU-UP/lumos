# Lumos · 灵光工作分身

当前阶段：本地核心最终验收通过，可以开始真实使用、边用边改。2026-09-23。后续维护在 Lumos 项目内部进行。

Lumos 的目标是持续维护工作理解，使更换对话、Agent 或设备后，仍能接上问题、依据、行动与成果。

- [最终验收与使用交接](docs/final-acceptance.md)：能力、修复、使用边界及下一阶段。
- [设计复审验收与实现指示](docs/review-acceptance.md)：本轮通过结论、首批范围和运行验收要求。
- [Agent 操作入口](AGENTS.md)与[本地工具说明](docs/local-core.md)：恢复上下文、候选保存、纠正、备份及迁移。
- [实现验收记录](docs/implementation-acceptance.md)：实际运行结果、复现命令及仍未验证的边界。
- [最小方案与场景推演](docs/minimal-design.md)：本轮推荐、数据职责、恢复与迁移、第一版边界。
- [参考核查与评审交接](docs/review-handoff.md)：证据范围、逐项修订对应位置与复审关注点。

当前入口是入职后的真实工作。支持对话记录、近期关注汇总，以及本机可编辑看板；入职前准备保留在归档中。页面和对话共用任务数据库、保存校验与修改历史。

Python 3.12+，无第三方依赖。在工程目录运行：

```text
py -3 lumos.py status
py -3 lumos.py context 入职
py -3 lumos.py verify
py -3 lumos.py tasks
py -3 lumos.py serve
py -3 -m unittest discover -s tests -v
```

默认工作数据位于 Git 忽略的 `lumos-data/`，也可用 `--data` 或 `LUMOS_DATA` 指定。首次空数据根用 `init`，已有数据不要重新初始化。真实初始化仅保留用户已提供的准备背景；模拟决定、行动和故障数据只在 `.local/` 隔离环境中使用。

运行 `serve` 后打开 http://127.0.0.1:8765 。支持新增、编辑、完成和取消任务，日期可留空，详情可看相关背景与历史。页面刷新读取对话侧的最新修改；版本冲突保留输入，不覆盖新记录。服务只监听本机；退出服务后页面无法读写。启动器不可用时可使用已安装的 Python 3.12+ 解释器直接运行。

Windows 也可双击仓库根目录的 `Lumos.exe`：自动启动本机服务并打开默认浏览器；服务已运行时直接打开，不重复启动。EXE需要与仓库和数据放在一起，并使用本机已安装的Python 3.12+，不是独立打包的完整应用。可为它创建桌面快捷方式，不要只移动EXE。关闭网页不会停止后台服务；重启电脑后再次双击即可。启动器源代码在 `tools/LumosLauncher.cs`，运行 `tools/build-launcher.ps1` 重新生成（生成的EXE不进Git）。

使用细节见[任务与看板说明](docs/task-board.md)。设计文档保留历史评审状态，不能覆盖后续已授权功能。Notion、云同步、定时推送和自动备份未实现。Git 不携带工作数据，本机备份尚不代表设备故障保障。
