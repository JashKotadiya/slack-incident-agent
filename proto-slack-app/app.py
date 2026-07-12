import logging
import os

from dotenv import load_dotenv
from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler
from slack_sdk import WebClient

from agent import get_model
from listeners import register_listeners
from poller import start_snowflake_poller

load_dotenv(dotenv_path=".env", override=False)
get_model()  # Fail fast if no AI provider key is configured

logging.basicConfig(level=logging.DEBUG)

app = App(
    token=os.environ.get("SLACK_BOT_TOKEN"),
    client=WebClient(
        base_url=os.environ.get("SLACK_API_URL", "https://slack.com/api"),
        token=os.environ.get("SLACK_BOT_TOKEN"),
    ),
)

register_listeners(app)

# Starts a background thread that polls Snowflake for failed queries and opens
# an incident channel when new ones are found. No-op if Snowflake env vars
# (SNOWFLAKE_ACCOUNT / SNOWFLAKE_USER / SNOWFLAKE_PAT) aren't set.
start_snowflake_poller(app.client)

if __name__ == "__main__":
    SocketModeHandler(app, os.environ.get("SLACK_APP_TOKEN")).start()
