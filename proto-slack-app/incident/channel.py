"""Incident channel creation and debrief posting.

When the Snowflake poller detects new failures, this module spins up a
dedicated Slack channel, invites the security/on-call team, and posts an
initial debrief message so responders have full context immediately.
"""

import logging
import os
from datetime import datetime, timezone

from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError

logger = logging.getLogger(__name__)


def _security_team_user_ids() -> list[str]:
    """Read the comma-separated list of Slack user IDs to invite from env."""
    raw = os.environ.get("SECURITY_TEAM_USER_IDS", "")
    return [uid.strip() for uid in raw.split(",") if uid.strip()]


def create_incident_channel(
    client: WebClient,
    incident_slug: str,
    summary: str,
    raw_details: str | None = None,
) -> str | None:
    """Create a new incident channel, invite the security team, and post a debrief.

    Args:
        client: Bot WebClient used to create the channel and post messages.
        incident_slug: Short, filesystem/channel-name-safe identifier (e.g. "wh-load-spike").
        summary: Plain-English summary of the incident (from the agent/Slack AI).
        raw_details: Optional raw query/task results to include for reference.

    Returns:
        The new channel ID, or None if channel creation failed.
    """
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
    channel_name = f"incident-{incident_slug}-{timestamp}"[:80].lower()

    try:
        response = client.conversations_create(name=channel_name, is_private=False)
        channel_id = response["channel"]["id"]
    except SlackApiError as e:
        logger.exception("Failed to create incident channel: %s", e.response.get("error"))
        return None

    security_team = _security_team_user_ids()
    if security_team:
        try:
            client.conversations_invite(channel=channel_id, users=",".join(security_team))
        except SlackApiError as e:
            # Non-fatal: continue posting the debrief even if invites partially failed.
            logger.warning("Failed to invite security team: %s", e.response.get("error"))

    blocks = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": f"🚨 Incident: {incident_slug}"},
        },
        {"type": "section", "text": {"type": "mrkdwn", "text": summary}},
    ]
    if raw_details:
        blocks.append({"type": "divider"})
        blocks.append(
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": f"```{raw_details[:2900]}```"},
            }
        )

    try:
        client.chat_postMessage(
            channel=channel_id,
            text=f"Incident: {incident_slug}",
            blocks=blocks,
        )
    except SlackApiError as e:
        logger.exception("Failed to post incident debrief: %s", e.response.get("error"))

    return channel_id
