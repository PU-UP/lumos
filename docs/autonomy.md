# 工作替身：自主整理与内部安排

2026-11-14用户批准实施。目标是从大段对话/笔记持续维护工作理解，减少逐task确认；不是自动联系同事或正式人事任命。

## 一次输入，一批保存

主线页有进展摘要和交付时间线两个视角。全部任务保留作查询与纠错，旧链接不失效。结束笔记后自动建立固定版本的intake；服务运行且本机Codex已登录时，后台执行器处理待整理队列。不会自动扫入所有旧笔记，旧笔记可点“整理这篇笔记”。

处理流程：固定原文→读取同空间当前任务/主线/人员和确切依据→生成变更计划→校验来源/授权/版本/字段→一次保存所有变更和处理回执→读回。普通记录建evidence，明确可交付事项才建action。完成与取消需要输入依据，不能因为到期或主线推进推定完成。

笔记、任务、主线和人员引用同一正式数据根，没有第二套业务库。笔记要点全部承接且没有待核对内容才自动归档，固定版本引用保留；有剩余内容保留未归档。原文在规划过程中修改则旧计划作废，结束新版本后再整理。任务/人员等依据变化则拒绝旧结果，不覆盖新内容。重复应用同一计划不新增任务或历史；失败计划保存在incoming/agent-plans供核对，原文不丢，回执可重试。

## 日期、分工和判断

- due继续表示明确约定，planned_due为Agent内部目标；二者独立。时间线优先按具体due，没有具体due时可展示Agent目标并标明性质；长期和未约定无内部目标时仍单列。不能把预测延期变成原承诺延期。
- follow_up/review_on允许Agent依据阶段节点、依赖和阻塞自主安排空缺或自己的日期并说明原因。review_basis=user（含主动清空）及历史已有日期但未标basis均按用户安排保护，只能凭新的明确用户安排修改，不能只改basis绕过。reported及review_basis=user表示新明确用户安排；planned或review_basis=agent表示推断。同值保存保留原依据；仅摘要更新不动日期。可靠工期未知时先安排复核，不捏造交付日期。
- 用户明确报告完成但没有日期时，授权流程采用报告录入当天（上海日期），在来源date_basis说明；实际日期明确时沿用。不得覆盖due，不推定技术验收通过。旧记录不批量补日期，普通网页完成选择保持。
- 已有明确owner优先；新任务沿用实际模块分工或有依据的职责判断。Agent分配标owner_basis=agent、owner_reason；关心安排标review_basis/review_reason。无可靠归属则待分配，不默认全部交王牧楠。用户普通编辑负责人/关心日会标为用户安排。
- person.assessment独立保存当前职责理解、适合承接事项、不确定点、basis_ids及原文/日期。可由实际任务安排、组织结构和日常反馈持续修正；不能从Agent自己刚分配的新任务循环推导能力。过去分工可作为延续职责依据，不能当作能力验证。保留矛盾和历史，不给能力排名，不推断人格或敏感属性。岗位/组长任命、团队归属、候选/到岗状态仍是原正式字段。
- 重大跨组资源冲突、修改明确承诺、关键证据矛盾才集中提问；普通记录、摘要、内部目标、复核和有依据的分配直接维护。分配仅在Lumos内部记录，不代表已通知或当事人接受。

本节与AGENTS.md及后台planner采用同一规则。普通查看、分类和摘要润色仍保留原日期；自主安排经intake批次保存，不能伪造用户原话。task-save的follow_up_reviewed兼容旧调用，不作为自主安排入口。

## 对话Agent入口

先status、context work-current、tasks恢复实际背景。进展输入写incoming请求：request_id为UUID hex、workspace、title、text、source、execution="conversation"。运行intake-save，再intake-claim返回ID（后台执行器不会抢占conversation输入），intake-context读取固定原文、当前records、basis、claim。

intake-apply请求：id、claim、basis、plan。plan包含summary、questions、updates、resolutions（旧请求省略等同空数组）；每个update为id、kind、changes（变化字段对象）、reason、excerpt（原文连续摘录）、mode（reported/planned）。支持action、已有mainline、已有person的assessment、新evidence；遵循docs/agent-planner.md。模型执行器用changes_json字符串承载对象，读入后转换为同一changes格式。

用户来源及Agent推断分开。单条任务混合事实与安排时，owner_basis/review_basis可明确agent；planned_due始终为内部安排。所有更新先共同验证，任务生命周期复用prepare_task，不单独重写数据库。失败不得把任务写了一半或提前归档笔记。对话输入本轮已处理就不要另交后台重复处理。

intakes --workspace lingguang查看回执；intake-context ID查看输入与当前依据；intake-claim ID可领取明确对话输入。intake-save带id和expected_revision重试失败输入；needs_review应通过新反馈接续，不能重跑旧原文改写问题身份。运行中的处理只在15分钟租约过期后可重新领取。旧执行者的claim不能覆盖新结果。agent-once检查到期复核并处理一个自动队列项，用于维护核对，不是第二套调度器。

## 到期复核与问题接续

服务按上海日期检查active主线的review_on，到期建立持久intake；同一主线、日期和安排版本只入队一次，优先处理用户输入。改期/清空/归档使尚未执行的旧安排作废；执行中发生变化拒绝旧结果。失败保留回执，手动重试，不无限调用模型。用户重新保存同日安排可发起新一轮复核；Agent新日期必须晚于今天，防止同日循环。

到期复核没有新用户报告，只允许核对该主线现有摘要、风险、下一步和Agent复核安排，不改任务、承诺、人员、阶段或as_of，不关闭旧问题。无新证据明确写未知；重大缺口才提问。成功后保存review_checked_on/review_checked_revision/review_checked_at及review_receipt，保留原review_on及依据。页面标明本次已复核；用户日期不会被悄悄顺延。

intake-context返回同空间open_questions，带intake_id和零起始index。新反馈明确回答时，plan.resolutions传{intake_id,index,answer,excerpt}，excerpt为本轮原文；并同步受影响事项。未回答/部分回答的问题保留，不重复提问，不将业务完成与问题关闭混淆。原问题与答案、source_intake、时间保留；全部回答后旧回执done，部分回答仍needs_review。新任务变更、旧问题关闭和新回执原子保存；并发回答会触发版本冲突。原笔记仅在全文已承接、问题全部处理且原版本未变化时归档，编辑后的新内容仍保留。服务关闭时不执行，重开后接续。

## 执行与边界

网页「对话」通过本机 Codex 连续讨论任务：每轮选择模型，列表读取 CODEX_HOME（默认 ~/.codex）下 models_cache.json 的可见模型；列表只是本机缓存，不代表当前账户一定能调用。选择默认时沿用执行器默认模型，不修改 Codex 全局配置。每轮的模型、原话、reply、处理回执保存在正式数据根的 intake 中；聊天不写入 Codex 桌面对话列表。

网页对话使用 automatic 执行，chat_id 为 UUID hex，chat_parent 为同空间上一轮 intake ID，model 为空或模型标识。当前一轮完成后才能接续；并发或过期 parent 拒绝保存，失败原轮可重试。下一轮读取本对话历史和当前空间记录，历史建议不能作为新的明确安排。reply 与变更原子保存，失败没有部分结果；纯讨论允许无业务更新，保留原话及答复，不制造任务或依据。普通笔记/进展整理仍要求实际承接，不能用 reply 绕过。对话规约见 docs/chat-planner.md。

网页草稿和未确认请求暂存在浏览器，收到保存确认才清空；连接中断重试沿用同一 request_id。聊天与整理共用单个后台队列，不提供流式输出、附件、外部通知、联网或代码执行。历史变长可能超出所选模型上下文限制，此时保留失败消息，可新开对话并明确承接事项；当前工作记录仍会重新读取。

正式数据中lumos-autonomy-policy为用户授权decision，autonomy_workspaces限定空间，status=current启用。停用该决定后不再处理队列，原来源和历史仍可读取。启动lumos.py serve同时启动队列执行器；关闭服务/电脑时不执行，重开后接续持久队列。不存在脱离服务的系统计划任务。

复用本机已安装并登录的Codex，调用exec的临时会话和结构化输出；不更改用户Codex配置，不额外保存密钥。使用只读执行、禁用shell/多Agent/Apps/网页检索，不允许整理器执行工具或直接写库；校验器才负责保存。它使用当前登录账户的额度，断网、登录失效或结果不合规则时显示失败并保留原文，不无限重试。相关资料会作为整理输入交给本机Codex所使用的模型服务。

实现依据：已安装CLI的exec帮助及[官方非交互模式说明](https://learn.chatgpt.com/docs/non-interactive-mode)、[配置说明](https://learn.chatgpt.com/docs/config-file/config-reference)。不自动选择或更改模型套餐。

正式文档文件的修改、备份和迁移仍须暂停外部编辑。intake只写版本记录，持锁验证后一起提交，不覆盖工作文档；因此普通笔记整理不需要每次要求用户停止打字。队列源笔记编辑中的版本不会被应用。所有示例和故障测试只在隔离数据执行。
