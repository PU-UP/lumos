"""Create a marked, isolated cold-start acceptance fixture. Never seeds real work."""
import argparse
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import lumos
from test_core import fixture


def create(root):
    root = Path(root).resolve()
    lumos.require(root.is_relative_to(lumos.ENGINE / ".local"), "Fixture must live under ignored .local/")
    lumos.initialize(root)
    store = lumos.Store(root)
    request = fixture()
    decision = {"id": "D1", "kind": "decision", "data": {
        "context": "mapping", "text": "模拟旧理解：已选定无视觉生产路线", "status": "current",
        "reason": "模拟：误解了准备期先做基线的范围", "scope": "模拟产品路线",
        "source": {"type": "user", "ref": "ISOLATED-FIXTURE:误记的阶段选择"}}}
    action = {"id": "baseline", "kind": "action", "data": {
        "context": "mapping", "text": "模拟：运行一次基线", "condition": "交付带条件和限制的试验记录",
        "status": "todo", "source": {"type": "user", "ref": "ISOLATED-FIXTURE:阶段验证"}}}
    request["updates"] += [decision, action]
    request["links"] += [["baseline", "D1", "depends_on"], ["plan", "D1", "derived_from"]]
    batch = store.begin(request, True)
    Path(batch["candidates"]["map"]).write_text("# 隔离模拟：入职准备\n八方向为准备地图，不是八个行动。建图定位是当前练习问题。", encoding="utf-8")
    Path(batch["candidates"]["plan"]).write_text("# 隔离模拟：建图定位\n旧理解见 D1，待核查来源范围。", encoding="utf-8")
    store.commit(batch["batch"], True)

    decision["data"]["status"] = "superseded"
    action["data"].update(status="blocked", waiting="取得同步与标定资料")
    talk = next(n for n in request["updates"] if n["id"] == "talk")
    talk["data"].update(status="done", completion={"basis": "user_report", "ref": "ISOLATED-FIXTURE:用户明确说聊完了"})
    correction = {"id": "D2", "kind": "decision", "data": {
        "context": "mapping", "text": "模拟：先核对同步与标定，再确定基线验证条件", "status": "current",
        "reason": "模拟用户澄清：此前只讨论准备期验证，不是无视觉生产选型", "scope": "模拟准备期",
        "supersedes": "D1", "source": {"type": "user", "ref": "ISOLATED-FIXTURE:用户更正"}}}
    batch = store.begin({"reason": "ISOLATED-FIXTURE:纠正误解并维护影响", "updates": [decision, correction, action, talk],
        "documents": [request["documents"][1]],
        "unlink": [["baseline", "D1", "depends_on"], ["plan", "D1", "derived_from"]],
        "links": [["baseline", "D2", "depends_on"], ["plan", "D2", "derived_from"]], "reviews": [
            {"id": i, "disposition": "updated", "reason": "纠正影响当前方案及下一步"} for i in ["plan", "baseline"]]}, True)
    Path(batch["candidates"]["plan"]).write_text(
        "# 隔离模拟：建图定位当前理解\n\n当前按 D2 先核查时间同步与标定资料。D1 将准备期基线误解为生产路线，已被取代。\n"
        "已有交流见 talk 的用户完成报告；这不证明硬件同步已经验证。baseline 等待资料。\n"
        "下一步应明确需要的时间戳、同步方式和标定版本；实际硬件配置及实验结果仍未知。\n"
        "这些全部是验收模拟，不是用户真实工作记录。", encoding="utf-8")
    store.commit(batch["batch"], True)
    return store.status()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    import json
    print(json.dumps(create(args.destination), ensure_ascii=False, indent=2))
