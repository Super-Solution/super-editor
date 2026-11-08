# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright 2026 SUPER SOLUTION LABS INC
"""The data the TypeScript package generates (action schemas, templates, routes, OpenAPI), loaded once."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from functools import lru_cache
from importlib import resources
from typing import Any


@dataclass(frozen=True)
class QueryParam:
    name: str
    field: str
    type: str
    enum: tuple[str, ...] = ()
    nullable: bool = False


@dataclass(frozen=True)
class Route:
    method: str
    path: str
    operation_id: str
    write: bool
    legacy: bool
    query: tuple[QueryParam, ...]
    body: str


@dataclass(frozen=True)
class Action:
    name: str
    access: str
    input_schema: dict[str, Any]
    raw: dict[str, Any]


@dataclass(frozen=True)
class Spec:
    limits: dict[str, int]
    actions: list[Action]
    action_by_name: dict[str, Action]
    routes: list[Route]
    document_schema: dict[str, Any]
    transaction_schema: dict[str, Any]
    openapi: dict[str, Any]
    template_kinds: list[str]
    template_infos: list[Any]
    template_titles: dict[str, str]
    templates: dict[str, dict[str, Any]]
    root: dict[str, Any] = field(repr=False, default_factory=dict)


@lru_cache(maxsize=1)
def spec() -> Spec:
    root = json.loads(resources.files("super_editor").joinpath("server_spec.json").read_text("utf-8"))
    actions = [Action(a["name"], a["access"], a["inputSchema"], a) for a in root["actions"]]
    routes = [
        Route(
            r["method"],
            r["path"],
            r["operationId"],
            bool(r.get("write")),
            bool(r.get("legacy")),
            tuple(
                QueryParam(p["name"], p["field"], p["type"], tuple(p.get("enum", ())), bool(p.get("nullable")))
                for p in r.get("query", [])
            ),
            r.get("body", ""),
        )
        for r in root["routes"]
    ]
    return Spec(
        limits={k: int(v) for k, v in root["limits"].items()},
        actions=actions,
        action_by_name={a.name: a for a in actions},
        routes=routes,
        document_schema=root["documentSchema"],
        transaction_schema=root["transactionSchema"],
        openapi=root["openapi"],
        template_kinds=list(root["templateKinds"]),
        template_infos=root["templateInfos"],
        template_titles=dict(root["templateTitles"]),
        templates=root["templates"],
        root=root,
    )


def limit(name: str) -> int:
    return spec().limits[name]
