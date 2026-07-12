"""Background poller that watches Snowflake for new failures.

Snowflake doesn't push alerts, so this polls ACCOUNT_USAGE.QUERY_HISTORY (and
TASK_HISTORY) on an interval, summarizes any new failures with the agent's
model, and opens an incident channel via `incident.create_incident_channel`.

Runs in its own asyncio loop on a background thread so it doesn't block the
Bolt SocketModeHandler in app.py.
"""

import asyncio
import logging
import os
import threading

from slack_sdk import WebClient

from agent import get_model, run_agent
from agent.deps import AgentDeps
from incident import create_incident_channel
from mcp_servers.snowflake import get_snowflake_mcp_server
from poller.state import seen_failures

logger = logging.getLogger(__name__)

DEFAULT_POLL_INTERVAL_SECONDS = 60
DEFAULT_LOOKBACK_MINUTES = 5

# The Snowflake-Labs MCP server exposes a generic SQL execution tool. The exact
# tool name has changed across versions/forks, so this is configurable —
# double check with `list_tools()` against your installed server and update
# SNOWFLAKE_MCP_QUERY_TOOL in .env if it differs.
DEFAULT_QUERY_TOOL_NAME = "execute_query"

FAILED_QUERIES_SQL = """\
SELECT query_id, query_text, error_code, error_message, user_name,
       warehouse_name, start_time
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
WHERE execution_status = 'FAILED'
  AND start_time >= DATEADD('minute', -{lookback}, CURRENT_TIMESTAMP())
ORDER BY start_time DESC
"""


async def _fetch_failed_queries(lookback_minutes: int) -> list[dict]:
    """Query Snowflake for queries that failed within the lookback window."""
    server = get_snowflake_mcp_server()
    if server is None:
        return []

    query_tool = os.environ.get("SNOWFLAKE_MCP_QUERY_TOOL", DEFAULT_QUERY_TOOL_NAME)
    sql = FAILED_QUERIES_SQL.format(lookback=lookback_minutes)

    try:
        result = await server.direct_call_tool(query_tool, {"query": sql})
    except Exception:
        logger.exception("Snowflake MCP query failed")
        return []

    # Result shape depends on the server version — normalize to a list of dicts.
    if isinstance(result, dict) and "rows" in result:
        return result["rows"]
    if isinstance(result, list):
        return result
    logger.warning("Unexpected Snowflake MCP result shape: %r", type(result))
    return []


def _summarize_and_alert(client: WebClient, failures: list[dict]) -> None:
    """Summarize new failures with the agent and open an incident channel."""
    new_failures = [
        f for f in failures if seen_failures.is_new(f.get("query_id", str(f)))
    ]
    if not new_failures:
        return

    raw_details = "\n".join(
        f"{f.get('query_id')} | {f.get('error_code')} | {f.get('error_message')}"
        for f in new_failures
    )

    prompt = (
        "Summarize these failed Snowflake queries in plain English for an "
        "incident channel, and suggest likely remediation steps:\n\n" + raw_details
    )

    # A minimal AgentDeps — this run isn't tied to a specific Slack message,
    # so thread/user fields are placeholders and emoji reactions are skipped.
    deps = AgentDeps(
        client=client,
        user_id="system",
        channel_id="system",
        thread_ts="system",
        message_ts="system",
    )

    try:
        result = run_agent(prompt, deps)
        summary = result.output
    except Exception:
        logger.exception("Failed to summarize incident with agent; using raw details")
        summary = "Automated summary unavailable — see raw details below."

    slug = new_failures[0].get("error_code", "snowflake-failure")
    create_incident_channel(client, str(slug).lower(), summary, raw_details=raw_details)


async def _poll_loop(client: WebClient, interval_seconds: int, lookback_minutes: int) -> None:
    logger.info(
        "Snowflake poller started (interval=%ss, lookback=%sm)",
        interval_seconds,
        lookback_minutes,
    )
    while True:
        try:
            failures = await _fetch_failed_queries(lookback_minutes)
            if failures:
                _summarize_and_alert(client, failures)
        except Exception:
            logger.exception("Snowflake poller cycle failed")
        await asyncio.sleep(interval_seconds)


def start_snowflake_poller(client: WebClient) -> threading.Thread | None:
    """Start the Snowflake poller on a background thread, if configured.

    Returns the thread (already started, daemonized) or None if Snowflake
    credentials aren't set, in which case the poller is skipped entirely.
    """
    if get_snowflake_mcp_server() is None:
        logger.info("Snowflake poller disabled (no Snowflake credentials configured)")
        return None

    interval = int(os.environ.get("SNOWFLAKE_POLL_INTERVAL_SECONDS", DEFAULT_POLL_INTERVAL_SECONDS))
    lookback = int(os.environ.get("SNOWFLAKE_POLL_LOOKBACK_MINUTES", DEFAULT_LOOKBACK_MINUTES))

    get_model()  # fail fast if no AI provider is configured

    def _run():
        asyncio.run(_poll_loop(client, interval, lookback))

    thread = threading.Thread(target=_run, name="snowflake-poller", daemon=True)
    thread.start()
    return thread
