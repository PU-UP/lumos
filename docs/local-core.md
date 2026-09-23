# 本地核心使用与恢复

Python 3.12+，仅标准库。以下命令在工程根运行，Windows 用 `py -3`，其他环境用对应 Python。用户日常只需自然交流；JSON 与工具操作由 Agent 完成。

## 入口与数据位置

`py -3 lumos.py status` 查看位置、模式、修订及待处理会话。

`py -3 lumos.py context 入职` 按关键词／ID 读当前文档、相关记录及历史；无关键词列出所有脉络。关键词由 Agent 从问题提炼，工具不是自然语言检索器。正式版本与工作副本有差异时，结果列出草稿／缺失文件，不能将它们当已吸收内容。

`py -3 lumos.py verify` 检查数据库、必要引用与历史文件哈希，并列出未登记文件。

默认 `lumos-data/`，也可 `py -3 lumos.py --data <数据根> ...` 或设置 `LUMOS_DATA`。初次空目录使用 `init`；已有数据不能重复初始化。真实根 `lumos-data/`、试验 `.local/`、备份 `backups/` 都按目录忽略，不只忽略 SQLite 扩展名。新数据根在 Git 仓库内时必须整目录忽略且不得有已跟踪文件，否则拒绝初始化／恢复。

`lumos.sqlite3` 保存记录、引用、批次与历史；`work/`、`raw/`、`output/` 是工作副本；`versions/` 保存不可变正式文件；`candidates/` 保存基线、候选和冲突；`incoming/` 可放提交请求与尚未整理材料。除 `cache/`、本机控制文件、锁及单独备份的数据库外，备份完整扫描数据根，不遗漏未登记草稿。凭据不得放入数据根。

## 一批保存

暂停人工编辑／自动保存后：

```text
py -3 lumos.py begin lumos-data/incoming/change.json --quiet-files
# 按返回路径编辑 *.candidate，保留 *.base 与 batch.json 不动
py -3 lumos.py commit <返回的batch> --quiet-files
py -3 lumos.py context <问题关键词>
```

`begin` 的持久会话占用跨命令、跨工具重启有效；不能并行开启第二个编辑会话。请求使用 UTF-8 JSON，示例仅为工具格式，不可作为用户已发生的事实导入：

```json
{
  "reason": "说明本次有依据的更新原因",
  "updates": [
    {"id": "C1", "kind": "context", "data": {
      "title": "实际工作脉络", "aliases": ["相关关键词"],
      "entry": "DOC1", "status": "active"
    }}
  ],
  "documents": [
    {"id": "DOC1", "path": "work/current.md", "context": "C1",
     "title": "当前理解", "role": "understanding"}
  ],
  "links": [],
  "reviews": []
}
```

`updates` 中每项为**完整记录替换**，先从 `context` 读取现有记录，保留未变化字段与来源；没有删除节点操作。ID 用英文字母、数字、下划线或连字符，稳定不随标题改变。文档通过 `documents` 更新；每份登记文档固定 ID／路径，不提供通用重命名或版本分支功能。可以使用二进制候选登记来源或成果，Markdown 会直接进入上下文输出。

记录种类与最小字段：

| kind | data 必需字段与语义 |
| --- | --- |
| context | title、entry（当前理解文档 ID）；status 为 active/waiting/retained/archived |
| evidence | context、text、source；可增加发生／获取时间、适用条件、原始地址及材料 ID；未知不补造 |
| decision | context、text、source.type=user、reason、scope；状态 current/superseded |
| action | context、text、source、condition、status；状态 todo/doing/blocked/done/cancelled；负责人和日期可未知 |

`source` 至少含 `type` 与 `ref`；type 为 user（用户陈述）、user_report（用户转述／结果报告）、source（有来源材料）、agent（建议／假设）。可附必要 quote 与时间，ref 不依赖旧会话才能理解。Agent 提案写 evidence，不能登记为用户决定或承诺行动。

普通行动完成增加 `completion: {"basis":"user_report", "ref":"用户本次明确说聊完了"}`；实际观察可用 observed 并指向结果。不填写 `technical_result=passed` 即不作技术通过判断；如要记录通过，必须同时有 `acceptance` 和 `result_evidence`，并继续标明是谁报告／验证。工具只能校验字段，Agent 仍要核对来源是否真实。

`links` 每项为 `[来源ID,目标ID,关系]`，关系限 related/supports/refutes/depends_on/derived_from/supersedes。纠正后不再有效的当前引用通过 `unlink` 指定同样的三元组撤下，并用 `links` 指向新记录；只能撤下已存在的当前引用，不能移除 supersedes 替代历史。批次历史的 `link_changes` 保留改前／改后及原因，不删除旧决定。用于已有实际引用，不预建图谱。

## 纠正与冲突

方向性纠正创建新 evidence／decision，填写 `supersedes=旧ID` 和 `reason`，旧记录完整保留但状态改为 superseded。批次同时更新当前理解、受影响行动及当前依赖边，历史依据仍可指向旧记录。`reviews` 为每个原先或现在引用旧记录的对象及当前理解入口提供 `{id, disposition: updated或unchanged, reason}`；声称 updated 必须真的更新。移除旧边不能绕过影响核对。工具拒绝遗漏覆盖，但不会替 Agent 判断语义正确性。更新记录、文档和关系都在同一正式批次生效。

遇到人工变化，原文件不被旧候选替换。`candidates/<batch>/` 保留基线、候选和 conflict 文件。未提交或提交后副本冲突时：先读清错误及 `status`，用 `abandon <batch>` 释放会话（保留所有材料，**不撤销已提交数据库记录**）；重新 `begin` 捕获新基线，在新候选中合并，再提交。不要编辑旧 batch.json 伪造基线。

保存中断后 `recover <batch> --quiet-files`：提交前从旧正式状态重试，提交后只恢复未刷新的副本，已等于候选的文件跳过，另有人工变化的文件保留为冲突。若候选在不可变版本写入后又改变，拒绝覆盖该版本，需要保留材料并新建批次。

## 完整备份与隔离恢复

先关闭编辑会话，暂停人工编辑、编辑器自动保存及其他产出进程。`--quiet-files` 不能代替这项条件，也不能保证检测到外部程序在两次扫描之间修改后又还原的情况。

```text
py -3 lumos.py backup backups/local-20260923 --quiet-files
py -3 lumos.py --data .local/restore-check restore backups/local-20260923 --sandbox
py -3 lumos.py --data .local/restore-check context 入职
```

目的目录必须不存在，不能位于源数据根内。工具冻结本次写入，比较整组文件前后清单与目的端、使用 SQLite backup 接口、保存当前工程文件及版本清单，全部核对后生成 `COMPLETE`。不完整包留作排查，不能覆盖上一个可用备份；重新选择新目的路径进行整组重试。

备份包含 `data/`、`engine/`、manifest 和 COMPLETE。工程快照保存 Git 跟踪及未忽略的工程文件（含未提交修改），不包含 `.git` 历史库；清单注明工程提交与是否有未提交差异。可直接使用包内 `engine/lumos.py --data <恢复根>` 运行，不依赖原目录或远端仓库仍有该版本。数据库和文件缺一不可。

普通 `restore` 默认只读；`--sandbox` 允许隔离试验保存，但不能接管为正式工作位置，不能在其中开展一条平行真实工作。缓存不入备份，删除它不影响恢复。副本存在未登记材料／人工草稿时保留并列出，不替用户升级成正式结论。

独立备份落点尚未确定：当前本机快照只提供恢复演练和误操作恢复，**不提供设备损坏保障**。没有自动定时备份、保留期清理或加密实现；可在之后接入用户选定的成熟备份设施。

## 迁移接管与取消

首版工具在同一次协调中需要能访问旧根和新根；支持本机换目录或同时挂载可访问的位置。不实现离线两机的分布式接管协议；跨电脑可先携带完整包做只读／隔离恢复，正式接管需让协调工具可访问两端。不能直接复制 control.json 使另一份数据宣称 active。

```text
py -3 lumos.py migrate-start backups/migration-20260923 .local/new-main --quiet-files
py -3 lumos.py --data .local/new-main restore backups/migration-20260923 --source lumos-data
# 在新根读取、核对并保存一次有意义的试运行变化；不发外部消息或发布
py -3 lumos.py migrate-finish .local/new-main --quiet-files
```

冻结旧位置后，旧位置持续只读，重启也不解冻。新根先是 trial；finish 要求完整性检查通过、会话结束且已有一次保存验证，然后先把旧位置标为 retired，再令新位置 active。切换中断最多留下零个正式写入位置，重试 finish 即可完成；已接管后不能直接解冻旧根。

取消未完成接管：`py -3 lumos.py migrate-cancel --quiet-files`。工具先把新根标为 cancelled，完整保留其文件和独有试运行批次，并写非权威归档说明，再使旧根 active。旧根不会自动获得试运行变化；需保留的内容由 Agent 重新核对后另批保存。快照失败且尚无新根时也须显式取消才能解冻。接管已完成则不能取消，应从现行主位置另做迁移。

控制状态对遵循工具的 Agent 有效，不是操作系统权限墙；不能绕过工具手工改控制文件、SQLite 或不可变版本，也不能在冻结根内人工编辑。磁盘损坏、断电耐久性和离线多机仲裁未获实机验证。
