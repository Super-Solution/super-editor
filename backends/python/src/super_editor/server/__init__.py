# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright 2026 SUPER SOLUTION LABS INC
"""The Super Editor actions and HTTP API over the Python editor.

The TypeScript package defines the contract; the data it generates (action schemas, templates, routes, OpenAPI) is
shipped as ``server_spec.json``. ``run_action`` executes one action over a ``Service``; ``create_handler`` is the
framework-neutral HTTP handler and ``create_wsgi_app`` the same thing as a WSGI application.
"""

from .actions import Context, run_action
from .http import Cors, Handler, Options, Request, Response, create_handler
from .service import EditorService, Service
from .wsgi import create_wsgi_app

__all__ = [
    "Context",
    "Cors",
    "EditorService",
    "Handler",
    "Options",
    "Request",
    "Response",
    "Service",
    "create_handler",
    "create_wsgi_app",
    "run_action",
]
