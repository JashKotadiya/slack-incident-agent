"""Snowflake MCP server configuration.

Wraps the official Snowflake-Labs MCP server (https://github.com/Snowflake-Labs/mcp)
as a Pydantic AI toolset so the agent can query Snowflake metadata (query history,
task history, warehouse load, etc.) as tools during a conversation.

The server is spawned as a subprocess over stdio via `uvx`, so `uv`/`uvx` must be
installed on the host running the Bolt app.
"""

import logging
import os

from pydantic_ai.mcp import MCPServerStdio

logger = logging.getLogger(__name__)

# Prefix applied to every tool name exposed by this server (e.g. `snowflake_execute_query`)
# so it can't collide with tools from the Slack MCP server or built-in tools.
TOOL_PREFIX = "snowflake"


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

    return MCPServerStdio(
        command="uvx",
        args=["snowflake-labs-mcp"],
        env={
            "SNOWFLAKE_ACCOUNT": account,
            "SNOWFLAKE_USER": user,
            "SNOWFLAKE_PAT": pat,
        },
        tool_prefix=TOOL_PREFIX,
        timeout=30,
    )
