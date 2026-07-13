"""Snowflake MCP server configuration.

Wraps the official Snowflake-Labs MCP server (https://github.com/Snowflake-Labs/mcp)
as a Pydantic AI toolset so the agent can query Snowflake metadata (query history,
task history, warehouse load, etc.) as tools during a conversation.

The server is spawned as a subprocess over stdio via `uvx`, so `uv`/`uvx` must be
installed on the host running the Bolt app.
"""

import logging
import os
import sys
from pathlib import Path

from pydantic_ai.mcp import MCPServerStdio

logger = logging.getLogger(__name__)

# Prefix applied to every tool name exposed by this server (e.g.
# `snowflake_run_snowflake_query`) so it can't collide with tools from the Slack
# MCP server or built-in tools.
TOOL_PREFIX = "snowflake"

# The Snowflake-Labs MCP server requires a service configuration file (passed via
# --service-config-file) that declares which capabilities to expose; without it
# the server exits with "service_config_file cannot be None". Ours enables the
# SQL execution tool and permits SELECT. Override the path with
# SNOWFLAKE_SERVICE_CONFIG_FILE if needed.
DEFAULT_SERVICE_CONFIG_FILE = str(
    Path(__file__).resolve().parent.parent / "snowflake_service_config.yaml"
)


def get_snowflake_mcp_server() -> MCPServerStdio | None:
    """Build the Snowflake MCP server toolset from environment credentials.

    Returns None (and logs why) if Snowflake isn't configured, so callers can
    skip attaching the toolset instead of crashing at startup.
    """
    account = os.environ.get("SNOWFLAKE_ACCOUNT")
    user = os.environ.get("SNOWFLAKE_USER")
    pat = os.environ.get("SNOWFLAKE_PAT")

    if not (account and user and pat):
        logger.info(
            "Snowflake MCP Server disabled "
            "(set SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_PAT to enable)"
        )
        return None

    logger.info("Snowflake MCP Server enabled (account=%s, user=%s)", account, user)

    # Inherit the parent environment (PATH, APPDATA/USERPROFILE, etc.) so `uvx`
    # can actually locate itself, its cache, and any tools it shells out to.
    # Because account, user, and pat were pulled from os.environ, they are already in here.
    env = dict(os.environ)

    # `or` (not a .get default) so a present-but-empty env var can't blank the
    # path — an empty --service-config-file makes the server error with
    # "service_config_file cannot be None".
    service_config = (
        os.environ.get("SNOWFLAKE_SERVICE_CONFIG_FILE") or DEFAULT_SERVICE_CONFIG_FILE
    )

    # Bounds the MCP `initialize` handshake, during which the server opens its
    # persistent Snowflake connection. A cold connect can exceed the old 30s;
    # override with SNOWFLAKE_MCP_TIMEOUT_SECONDS if needed.
    timeout = float(os.environ.get("SNOWFLAKE_MCP_TIMEOUT_SECONDS") or "120")
    
    # Handle Windows environments which require the exact file extension for subprocesses
    command = "uvx.exe" if sys.platform == "win32" else "uvx"

    return MCPServerStdio(
        command=command,
        args=["snowflake-labs-mcp", "--service-config-file", service_config],
        env=env,
        tool_prefix=TOOL_PREFIX,
        timeout=timeout,
    )