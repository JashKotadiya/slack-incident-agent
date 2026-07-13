import logging
import os

from pydantic_ai import Agent
from pydantic_ai.mcp import MCPServerStreamableHTTP
from pydantic_ai.models import Model
from agent.deps import AgentDeps
from agent.tools import add_emoji_reaction
from mcp_servers import get_snowflake_mcp_server

SYSTEM_PROMPT = """\
You are a friendly Slack assistant. You help people by answering questions, \
having conversations, and being generally useful in Slack.

## PERSONALITY
- Friendly, helpful, and approachable
- Lightly witty — a touch of humor when appropriate, but never forced
- Concise and clear — respect people's time
- Confident but honest when you don't know something

## RESPONSE GUIDELINES
- Keep responses to 3 sentences max — be punchy, scannable, and actionable
- End with a clear next step on its own line so it's easy to spot
- Use a bullet list only for multi-step instructions
- Use casual, conversational language
- Use emoji sparingly — at most one per message, and only to set tone

## FORMATTING RULES
- Use standard Markdown syntax: **bold**, _italic_, `code`, ```code blocks```, > blockquotes
- Use bullet points for multi-step instructions

## SLACK MCP SERVER
You may have access to the Slack MCP Server, which gives you powerful Slack tools \
beyond your built-in tools. Use them whenever they would help the user.

Available capabilities:
- **Search**: Search messages and files across public channels, search for channels by name
- **Read**: Read channel message history, read thread replies, read canvas documents
- **Write**: Send messages, create draft messages, schedule messages for later
- **Canvases**: Create, read, and update Slack canvas documents

Use these tools when they can help answer a question or complete a task — for example, \
searching for relevant messages, checking a channel for context, or creating a canvas. \
Also use them when the user explicitly asks you to perform a Slack action.

## SNOWFLAKE MCP SERVER
When someone asks about failed queries, failed tasks, warehouse load, or database \
metadata, you MUST fetch real data with the Snowflake MCP tools (prefixed \
`snowflake_`, e.g. `snowflake_run_snowflake_query`). NEVER answer these questions \
from your own knowledge.

Grounding rules — follow exactly:
- Report ONLY what the tool actually returns. Never invent query IDs, timestamps, \
error codes, error messages, warehouse names, or user names.
- If the tool returns no rows, say plainly that there are no matching failures in \
the window. Do NOT manufacture examples to fill the gap.
- If the tool errors or isn't available, say so and quote the error. Do not guess.

To find recent failed queries (near-real-time), call `snowflake_run_snowflake_query` \
with SQL like the following. Replace <db> with a database you can access — the table \
function resolves against a database's information schema:

SELECT query_id, query_text, error_code, error_message, user_name, warehouse_name, start_time
FROM TABLE(<db>.INFORMATION_SCHEMA.QUERY_HISTORY(
    END_TIME_RANGE_START => DATEADD('hour', -1, CURRENT_TIMESTAMP()), RESULT_LIMIT => 100))
WHERE error_code IS NOT NULL
ORDER BY start_time DESC

Failure statuses appear as `FAILED_WITH_ERROR` / `FAILED_WITH_INCIDENT`, never the \
literal `FAILED`, so filter on `error_code IS NOT NULL` (not `execution_status = 'FAILED'`). \
Use `INFORMATION_SCHEMA.TASK_HISTORY(...)` for failed scheduled tasks. Prefer \
near-real-time `INFORMATION_SCHEMA` over `ACCOUNT_USAGE` (which lags ~45 min).

When summarizing, translate error codes/messages into plain English and suggest \
remediation grounded strictly in what the query results actually show.
"""

logger = logging.getLogger(__name__)

_cached_model: str | Model | None = None


def get_model() -> str | Model:
    """Select the AI model based on available API keys.

    Prefers Anthropic when both keys are set.
    """
    global _cached_model
    if _cached_model is not None:
        return _cached_model

    if os.environ.get("ANTHROPIC_API_KEY"):
        _cached_model = "anthropic:claude-sonnet-4-6"

    elif os.environ.get("GROQ_API_KEY"):
        # Imported lazily so the groq package is only required when a
        # GROQ_API_KEY is actually configured.
        from pydantic_ai.models.groq import GroqModel

        _cached_model = GroqModel('openai/gpt-oss-20b')

    elif os.environ.get("OPENAI_API_KEY"):
        _cached_model = "openai:gpt-4.1-mini"
    else:
        raise RuntimeError(
            "No AI provider configured. "
            "Set ANTHROPIC_API_KEY or OPENAI_API_KEY in your environment."
        )
    return _cached_model


SLACK_MCP_URL = "https://mcp.slack.com/mcp"

agent = Agent(
    deps_type=AgentDeps,
    system_prompt=SYSTEM_PROMPT,
    tools=[add_emoji_reaction],
)


def _build_toolsets(deps):
    """Assemble the MCP toolsets for a run based on available credentials."""
    toolsets = []
    if deps.user_token:
        logger.info("Slack MCP Server enabled (user_token present)")
        toolsets.append(
            MCPServerStreamableHTTP(
                SLACK_MCP_URL,
                headers={"Authorization": f"Bearer {deps.user_token}"},
            )
        )
    else:
        logger.info("Slack MCP Server disabled (no user_token)")

    snowflake_server = get_snowflake_mcp_server()
    if snowflake_server:
        toolsets.append(snowflake_server)
    return toolsets


def run_agent(text, deps, message_history=None):
    """Run the agent synchronously — for Bolt's sync listener handlers.

    Do NOT call this from async code (e.g. the poller's event loop); run_sync()
    wraps run_until_complete() and raises "this event loop is already running".
    Use run_agent_async() there instead.
    """
    return agent.run_sync(
        text,
        model=get_model(),
        deps=deps,
        message_history=message_history,
        toolsets=_build_toolsets(deps),
    )


async def run_agent_async(text, deps, message_history=None):
    """Run the agent from async code (e.g. the Snowflake poller's loop)."""
    return await agent.run(
        text,
        model=get_model(),
        deps=deps,
        message_history=message_history,
        toolsets=_build_toolsets(deps),
    )
