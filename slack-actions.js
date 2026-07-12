import { formatForSlack } from './slack-formatter.js';

export async function dmUser(client, userId, text, blocks = undefined) {
  try {
    await client.chat.postMessage({
      channel: userId,
      text: formatForSlack(text),
      blocks: blocks,
      unfurl_links: false
    });
    console.log(`DMed user ${userId}`);
  } catch (error) {
    console.error(`Error DMing user ${userId}:`, error);
  }
}

export async function createIncidentChannel(client, alertName) {
  try {
    // Channel names must be lowercase, alphanumeric, and max 80 chars
    const sanitizedName = alertName.toLowerCase().replace(/[^a-z0-9]/g, '-').substring(0, 70);
    const channelName = `incident-${sanitizedName}-${Math.floor(Math.random() * 1000)}`;

    const result = await client.conversations.create({
      name: channelName,
      is_private: false // Set to true if you want private incident channels
    });

    console.log(`Created channel ${channelName} with ID ${result.channel.id}`);
    return result.channel;
  } catch (error) {
    console.error("Error creating channel:", error);
    throw error;
  }
}

export async function inviteUsersToChannel(client, channelId, userIds) {
  if (!userIds || userIds.length === 0) return;
  try {
    await client.conversations.invite({
      channel: channelId,
      users: userIds.join(',')
    });
    console.log(`Invited users ${userIds.join(',')} to channel ${channelId}`);
  } catch (error) {
    console.error("Error inviting users. Note: the bot needs appropriate permissions, and cannot invite itself if it's already in the channel.", error);
    // Ignore already_in_channel or other non-fatal errors for the hackathon
  }
}

export async function postDebrief(client, channelId, summary, blocks = undefined) {
  try {
    await client.chat.postMessage({
      channel: channelId,
      text: formatForSlack(summary),
      blocks: blocks,
      unfurl_links: false
    });
    console.log(`Posted debrief to channel ${channelId}`);
  } catch (error) {
    console.error("Error posting debrief:", error);
    throw error;
  }
}
