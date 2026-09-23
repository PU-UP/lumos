# Lumos · 灵光工作分身

当前阶段：第一批本地核心及记录中的运行验收已完成，待 reviewer 做实现验收。2026-09-23。

Lumos 的目标是持续维护工作理解，使更换对话、Agent 或设备后，仍能接上问题、依据、行动与成果。

- [设计复审验收与实现指示](docs/review-acceptance.md)：本轮通过结论、首批范围和运行验收要求。
- [Agent 操作入口](AGENTS.md)与[本地工具说明](docs/local-core.md)：恢复上下文、候选保存、纠正、备份及迁移。
- [实现验收记录](docs/implementation-acceptance.md)：实际运行结果、复现命令及仍未验证的边界。
- [最小方案与场景推演](docs/minimal-design.md)：本轮推荐、数据职责、恢复与迁移、第一版边界。
- [参考核查与评审交接](docs/review-handoff.md)：证据范围、逐项修订对应位置与复审关注点。

第一批围绕“入职准备”和“建图定位”验证保存、行动、纠正、跨对话接续及完整迁移；本地通过后再接入一个 Lumos Project 和一篇展示子页。HTML 导出按需后置。

Python 3.12+，无第三方依赖。在工程目录运行：

```text
py -3 lumos.py status
py -3 lumos.py context 入职
py -3 lumos.py verify
py -3 -m unittest discover -s tests -v
```

默认工作数据位于 Git 忽略的 `lumos-data/`，也可用 `--data` 或 `LUMOS_DATA` 指定。首次空数据根用 `init`，已有数据不要重新初始化。真实初始化仅保留用户已提供的准备背景；模拟决定、行动和故障数据只在 `.local/` 隔离环境中使用。

设计文档保留历史评审状态；进入实现的依据是 review-acceptance.md。Notion、HTML、UI、后台及云共享均未实现。Git 不携带工作数据，本机备份尚不代表设备故障保障。
