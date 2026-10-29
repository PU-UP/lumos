"""People are versioned records, independent of task ownership and labels."""
from lumos import require


def validate_person(data):
    for key, limit in (("title", 300), ("team", 80), ("role", 2000)):
        value = data.get(key, "")
        require(isinstance(value, str) and len(value) <= limit, f"Invalid person {key}")
        require(key == "role" or not any(c in value for c in "\r\n\t"), f"Invalid person {key}")
    require(data["title"].strip() == data["title"] and data["title"], "Person needs a name")
    spaces = data.get("workspaces")
    require(isinstance(spaces, list) and spaces and all(isinstance(s, str) and s in {"lingguang", "lumos"} for s in spaces)
            and len(spaces) == len(set(spaces)), "Invalid person workspaces")
    for key, default, choices in (("status", "active", {"active", "archived"}),
                                  ("team_status", "confirmed", {"confirmed", "proposed"}),
                                  ("member_type", "human", {"human", "agent"})):
        require(isinstance(data.get(key, default), str) and data.get(key, default) in choices,
                f"Invalid person {key}")


def list_people(nodes, context_ids):
    people = [n for n in nodes.values() if n["kind"] == "person"
              and n["data"].get("status", "active") == "active" and n["data"]["context"] in context_ids]
    # Task owners are still names; reject ambiguous active names within a workspace.
    for workspace in ("lingguang", "lumos"):
        names = [p["data"]["title"] for p in people if workspace in p["data"]["workspaces"]]
        require(len(names) == len(set(names)), "Duplicate active person name in workspace")
    return sorted(people, key=lambda p: p["id"])
