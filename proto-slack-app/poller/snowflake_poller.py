"""Background poller that watches Snowflake for new failures.

Snowflake doesn't push alerts, so this polls query history on an interval,
summarizes any new failures with the agent's model, and opens an incident
channel via `incident.create_incident_channel`. The history source is
configurable via SNOWFLAKE_QUERY_HISTORY_SOURCE (see below).

Runs in its own asyncio loop on a background thread so it doesn't block the
Bolt SocketModeHandler in app.py.
"""

import asyncio
import logging
import os
import threading

from slack_sdk import WebClient

from agent import get_model, run_agent_async
from agent.deps import AgentDeps
from incident import create_incident_channel
from mcp_servers.snowflake import get_snowflake_mcp_server
from poller.state import seen_failures

logger = logging.getLogger(__name__)

DEFAULT_POLL_INTERVAL_SECONDS = 60
DEFAULT_LOOKBACK_MINUTES = 5

# The Snowflake-Labs MCP server exposes its generic SQL execution tool as
# `run_snowflake_query` (which takes a `statement` argument). The name has varied
# across versions/forks, so it stays configurable — override SNOWFLAKE_MCP_QUERY_TOOL
# in .env if `list_tools()` shows a different name.
DEFAULT_QUERY_TOOL_NAME = "run_snowflake_query"

# Where to read failed queries from. Set SNOWFLAKE_QUERY_HISTORY_SOURCE in .env:
#   "information_schema" (default) — INFORMATION_SCHEMA.QUERY_HISTORY table
#       function: near-real-time (seconds), ~7-day retention, capped rows. Best
#       for fast feedback and testing.
#   "account_usage" — SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY view: up to ~45 min
#       latency, 365-day retention, account-wide. Best for long-term history.
DEFAULT_QUERY_HISTORY_SOURCE = "information_schema"

# ACCOUNT_USAGE is a plain view, so it's read with a straight SELECT and filtered
# on START_TIME. We key "failed" off a non-null error_code rather than
# execution_status: the status vocabularies differ between history sources and
# none of them use the literal 'FAILED' (INFORMATION_SCHEMA uses
# 'FAILED_WITH_ERROR'), whereas any errored query has an error_code.
ACCOUNT_USAGE_SQL = """\
SELECT query_id, query_text, error_code, error_message, user_name,
       warehouse_name, start_time
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
WHERE error_code IS NOT NULL
  AND start_time >= DATEADD('minute', -{lookback}, CURRENT_TIMESTAMP())
ORDER BY start_time DESC
"""

# INFORMATION_SCHEMA.QUERY_HISTORY is a table function (hence the TABLE(...) call)
# that filters on END_TIME, so a query surfaces here right after it fails. It is
# resolved against a database's information schema; when SNOWFLAKE_DATABASE is set
# we qualify the call with it so it still works if the MCP session has no default
# database (otherwise Snowflake raises "no active database"). RESULT_LIMIT is
# maxed since the function caps rows (default 100).
INFORMATION_SCHEMA_SQL = """\
SELECT query_id, query_text, error_code, error_message, user_name,
       warehouse_name, start_time
FROM TABLE({db_prefix}INFORMATION_SCHEMA.QUERY_HISTORY(
         END_TIME_RANGE_START => DATEADD('minute', -{lookback}, CURRENT_TIMESTAMP()),
         RESULT_LIMIT => 10000
     ))
WHERE error_code IS NOT NULL
ORDER BY start_time DESC
"""


def _build_failed_queries_sql(lookback_minutes: int) -> str:
    """Build the failed-query SQL for the configured history source."""
    source = (
        os.environ.get("SNOWFLAKE_QUERY_HISTORY_SOURCE", DEFAULT_QUERY_HISTORY_SOURCE)
        .strip()
        .lower()
    )

    if source == "account_usage":
        return ACCOUNT_USAGE_SQL.format(lookback=lookback_minutes)

    if source != "information_schema":
        logger.warning(
            "Unknown SNOWFLAKE_QUERY_HISTORY_SOURCE %r; using %r",
            source,
            DEFAULT_QUERY_HISTORY_SOURCE,
        )

    db = os.environ.get("SNOWFLAKE_DATABASE", "").strip()
    db_prefix = f"{db}." if db else ""
    return INFORMATION_SCHEMA_SQL.format(lookback=lookback_minutes, db_prefix=db_prefix)


async def _fetch_failed_queries(lookback_minutes: int) -> list[dict]:
    """Query Snowflake for queries that failed within the lookback window."""
    server = get_snowflake_mcp_server()
    if server is None:
        return []

    query_tool = os.environ.get("SNOWFLAKE_MCP_QUERY_TOOL", DEFAULT_QUERY_TOOL_NAME)
    sql = _build_failed_queries_sql(lookback_minutes)

    try:
        # run_snowflake_query takes the SQL under a `statement` argument.
        result = await server.direct_call_tool(query_tool, {"statement": sql})
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


def _failure_field(row: dict, name: str):
    """Case-insensitive column lookup. Snowflake returns column names uppercased
    by default, so ``row["query_id"]`` misses; tolerate either casing."""
    if name in row:
        return row[name]
    return row.get(name.upper(), row.get(name.lower()))


def _failure_signature(row: dict) -> str:
    """Stable key for a *kind* of failure (error code + normalized statement).

    Deduping on this instead of query_id means a recurring failure — e.g. a
    scheduled task erroring every minute, each run with a fresh query_id — opens
    a single incident instead of one per run.
    """
    error_code = _failure_field(row, "error_code")
    query_text = _failure_field(row, "query_text") or ""
    # Collapse whitespace + lowercase so identical statements match regardless of
    # formatting; cap length to keep the dedup key bounded.
    normalized = " ".join(str(query_text).split()).lower()[:500]
    return f"{error_code}::{normalized}"


async def _summarize_and_alert(client: WebClient, failures: list[dict]) -> None:
    """Summarize new failures with the agent and open an incident channel."""
    new_failures = [
        f for f in failures if seen_failures.is_new(_failure_signature(f))
    ]
    if not new_failures:
        return

    raw_details = "\n".join(
        f"{_failure_field(f, 'query_id')} | {_failure_field(f, 'error_code')} | "
        f"{_failure_field(f, 'error_message')}"
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
        result = await run_agent_async(prompt, deps)
        summary = result.output
    except Exception:
        logger.exception("Failed to summarize incident with agent; using raw details")
        summary = "Automated summary unavailable — see raw details below."

    slug = _failure_field(new_failures[0], "error_code") or "snowflake-failure"
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
                await _summarize_and_alert(client, failures)
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
