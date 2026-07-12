import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HISTORY_FILE = path.join(__dirname, 'incident-history.json');

export async function getRecentHistory(limit = 5) {
  try {
    const data = await fs.readFile(HISTORY_FILE, 'utf-8');
    const history = JSON.parse(data);
    return history.slice(-limit);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return []; // File doesn't exist yet
    }
    console.error("Error reading history store:", error);
    return [];
  }
}

export async function addIncidentToHistory(incidentSummary) {
  try {
    let history = [];
    try {
      const data = await fs.readFile(HISTORY_FILE, 'utf-8');
      history = JSON.parse(data);
    } catch (e) {
      if (e.code !== 'ENOENT') console.error("Error reading history store during add:", e);
    }

    // Keep only the last 50 incidents so the file doesn't grow infinitely
    history.push({
      timestamp: new Date().toISOString(),
      summary: incidentSummary
    });
    
    if (history.length > 50) {
      history = history.slice(-50);
    }

    await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (error) {
    console.error("Error saving to history store:", error);
  }
}
