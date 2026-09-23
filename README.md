# Lumos · 灵光工作分身

当前阶段：本地核心最终验收通过，可以开始真实使用、边用边改。2026-09-23。后续维护在 Lumos 项目内部进行。

Lumos 的目标是持续维护工作理解，使更换对话、Agent 或设备后，仍能接上问题、依据、行动与成果。

- [最终验收与使用交接](docs/final-acceptance.md)：能力、修复、使用边界及下一阶段。
- [设计复审验收与实现指示](docs/review-acceptance.md)：本轮通过结论、首批范围和运行验收要求。
- [Agent 操作入口](AGENTS.md)与[本地工具说明](docs/local-core.md)：恢复上下文、候选保存、纠正、备份及迁移。
- [实现验收记录](docs/implementation-acceptance.md)：实际运行结果、复现命令及仍未验证的边界。
- [最小方案与场景推演](docs/minimal-design.md)：本轮推荐、数据职责、恢复与迁移、第一版边界。
- [参考核查与评审交接](docs/review-handoff.md)：证据范围、逐项修订对应位置与复审关注点。

下一阶段以真实入职准备和建图定位讨论验证工作效果，持续留下当前理解、依据与成果。优先解决真实使用中的遗漏或接续问题；有稳定内容与跨设备阅读需要时，再接入一个 Notion Lumos Project 和展示子页。HTML 导出按需后置。

Python 3.12+，无第三方依赖。在工程目录运行：

```text
py -3 lumos.py status
py -3 lumos.py context 入职
py -3 lumos.py verify
py -3 -m unittest discover -s tests -v
```

默认工作数据位于 Git 忽略的 `lumos-data/`，也可用 `--data` 或 `LUMOS_DATA` 指定。首次空数据根用 `init`，已有数据不要重新初始化。真实初始化仅保留用户已提供的准备背景；模拟决定、行动和故障数据只在 `.local/` 隔离环境中使用。

设计文档保留历史评审状态；进入实现的依据是 review-acceptance.md。Notion、HTML、UI、后台及云共享均未实现。Git 不携带工作数据，本机备份尚不代表设备故障保障。
