"""Incident channel creation and debrief posting.

When the Snowflake poller detects new failures, this module posts an initial
debrief so responders have full context immediately. By default it spins up a
dedicated Slack channel and invites the security/on-call team; if
``SLACK_INCIDENT_CHANNEL`` is set it posts into that existing channel instead
(simpler on org-wide Enterprise Grid installs, where creating channels requires
a member-workspace ``team_id`` the app is approved on).
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


def _incident_team_id(client: WebClient) -> str | None:
    """Resolve the workspace (team) ID to create the incident channel in.

    Org-level (Enterprise Grid) installs must tell ``conversations.create`` which
    workspace to use, otherwise it fails with ``missing_argument: team_id``.
    Prefer an explicit SLACK_TEAM_ID (a ``T…``-prefixed workspace id); fall back
    to ``auth.test`` for single-workspace installs.
    """
    team_id = os.environ.get("SLACK_TEAM_ID")
    if team_id:
        return team_id
    try:
        return client.auth_test().get("team_id")
    except SlackApiError as e:
        logger.warning(
            "Could not resolve team_id via auth.test: %s", e.response.get("error")
        )
        return None


def _post_debrief(
    client: WebClient,
    channel_id: str,
    incident_slug: str,
    summary: str,
    raw_details: str | None,
) -> None:
    """Post the incident header + summary (+ raw details) to a channel."""
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


def create_incident_channel(
    client: WebClient,
    incident_slug: str,
    summary: str,
    raw_details: str | None = None,
) -> str | None:
    """Post an incident debrief, creating a dedicated channel unless one is configured.

    If ``SLACK_INCIDENT_CHANNEL`` is set, the debrief is posted to that existing
    channel (the bot must be a member) and no channel is created. Otherwise a new
    ``incident-<slug>-<timestamp>`` channel is created and the security team invited.

    Args:
        client: Bot WebClient used to create the channel and post messages.
        incident_slug: Short, channel-name-safe identifier (e.g. "wh-load-spike").
        summary: Plain-English summary of the incident (from the agent).
        raw_details: Optional raw query/task results to include for reference.

    Returns:
        The channel ID used (created or existing), or None if it failed.
    """
    # Post into a pre-existing channel when configured — avoids conversations.create
    # entirely, which is the simplest path on org-wide installs.
    existing_channel = os.environ.get("SLACK_INCIDENT_CHANNEL")
    if existing_channel:
        logger.info("Posting incident to existing channel %s", existing_channel)
        _post_debrief(client, existing_channel, incident_slug, summary, raw_details)
        return existing_channel

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
    channel_name = f"incident-{incident_slug}-{timestamp}"[:80].lower()

    create_kwargs = {"name": channel_name, "is_private": False}
    team_id = _incident_team_id(client)
    if team_id:
        # Required for org-level installs; harmless for single-workspace ones.
        create_kwargs["team_id"] = team_id

    try:
        response = client.conversations_create(**create_kwargs)
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

    _post_debrief(client, channel_id, incident_slug, summary, raw_details)
    return channel_id
