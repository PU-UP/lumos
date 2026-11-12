"""People are versioned records, independent of task ownership and labels."""
from lumos import require


def validate_person(data):
    for key, limit in (("title", 300), ("team", 80), ("role", 2000), ("arrival_note", 500),
                       ("org_role", 80), ("org_note", 500)):
        value = data.get(key, "")
        require(isinstance(value, str) and len(value) <= limit, f"Invalid person {key}")
        require(key == "role" or not any(c in value for c in "\r\n\t"), f"Invalid person {key}")
    require(data["title"].strip() == data["title"] and data["title"], "Person needs a name")
    spaces = data.get("workspaces")
    require(isinstance(spaces, list) and spaces and all(isinstance(s, str) and s in {"lingguang", "lumos"} for s in spaces)
            and len(spaces) == len(set(spaces)), "Invalid person workspaces")
    for key, default, choices in (("status", "active", {"active", "archived"}),
                                  ("membership_status", "member", {"member", "candidate"}),
                                  ("team_status", "confirmed", {"confirmed", "proposed"}),
                                  ("member_type", "human", {"human", "agent"})):
        require(isinstance(data.get(key, default), str) and data.get(key, default) in choices,
                f"Invalid person {key}")


def validate_org_chart(chart):
    required = {"title", "lead_team", "branches", "notes"}
    require(isinstance(chart, dict) and required <= set(chart)
            and set(chart) <= required | {"hidden_people", "team_details", "caption"},
            "Invalid organization chart")
    def text(value):
        return isinstance(value, str) and bool(value.strip()) and len(value) <= 500
    require(text(chart["title"]) and (chart["lead_team"] == "" or text(chart["lead_team"])), "Invalid organization title/lead team")
    require("caption" not in chart or text(chart["caption"]), "Invalid organization caption")
    hidden = chart.get("hidden_people", [])
    require(isinstance(hidden, list) and all(text(name) for name in hidden), "Invalid hidden people")
    require(isinstance(chart["notes"], list) and all(text(n) for n in chart["notes"]), "Invalid organization notes")
    require(isinstance(chart["branches"], list) and 0 < len(chart["branches"]) <= 12, "Invalid organization branches")
    teams = [chart["lead_team"]] if chart["lead_team"] else []
    for branch in chart["branches"]:
        require(isinstance(branch, dict) and {"title", "teams", "lead_label"} <= set(branch)
                and set(branch) <= {"title", "teams", "lead_label", "direct"}, "Invalid organization branch")
        require(type(branch.get("direct", False)) is bool, "Invalid direct organization branch")
        require(text(branch["title"]) and text(branch["lead_label"]), "Invalid organization branch title/lead")
        require(isinstance(branch["teams"], list) and branch["teams"] and all(text(t) for t in branch["teams"]),
                "Invalid organization teams")
        teams.extend(branch["teams"])
        require(not branch.get("direct") or len(branch["teams"]) == 1, "Direct branch must contain one team")
    require(len(teams) == len(set(teams)), "Duplicate organization team")
    details = chart.get("team_details", {})
    require(isinstance(details, dict) and set(details) <= set(teams), "Invalid organization team details")
    for detail in details.values():
        require(isinstance(detail, dict) and set(detail) == {"lead_label", "plan"}
                and (detail["lead_label"] == "" or text(detail["lead_label"])) and text(detail["plan"]),
                "Invalid organization team plan")


def list_people(nodes, context_ids):
    people = [n for n in nodes.values() if n["kind"] == "person"
              and n["data"].get("status", "active") == "active" and n["data"]["context"] in context_ids]
    # Task owners are still names; reject ambiguous active names within a workspace.
    for workspace in ("lingguang", "lumos"):
        names = [p["data"]["title"] for p in people if workspace in p["data"]["workspaces"]]
        require(len(names) == len(set(names)), "Duplicate active person name in workspace")
    return sorted(people, key=lambda p: p["id"])
