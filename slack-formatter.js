export function formatForSlack(text) {
  if (!text) return text;

  // 0. Unescape literal \n that sometimes comes from the AI
  let formatted = text.replace(/\\n/g, '\n');

  // 1. Replace **bold** with *bold* (Slack uses single asterisks)
  formatted = formatted.replace(/\*\*(.*?)\*\*/g, '*$1*');

  // 2. Replace markdown headers with bold text (Slack doesn't support # Headers)
  formatted = formatted.replace(/^###\s+(.*$)/gm, '*$1*');
  formatted = formatted.replace(/^##\s+(.*$)/gm, '*$1*');
  formatted = formatted.replace(/^#\s+(.*$)/gm, '*$1*');

  // 3. Replace HTML line breaks with actual newlines
  formatted = formatted.replace(/<br\s*\/?>/gi, '\n');

  // 4. Convert Markdown tables into readable Slack lists
  const lines = formatted.split('\n');
  let result = [];
  
  let tableHeaders = [];
  let inTable = false;

  for (let line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      let columns = trimmed.split('|').map(c => c.trim());
      columns.shift(); // remove empty element before first |
      columns.pop();   // remove empty element after last |
      
      const isSeparator = columns.every(c => /^[-:\s]+$/.test(c) && c.length > 0);
      
      if (!inTable && !isSeparator) {
        tableHeaders = columns.map(h => h.replace(/\*/g, '')); // store headers without bold
        inTable = true;
      } else if (isSeparator) {
        // Ignore separator line
      } else if (inTable) {
        result.push(''); // spacing between items
        for (let i = 0; i < columns.length; i++) {
          const header = tableHeaders[i] ? `*${tableHeaders[i]}:* ` : '';
          result.push(`• ${header}${columns[i]}`);
        }
      } else {
        result.push(line);
      }
    } else {
      if (inTable) {
        inTable = false;
        tableHeaders = [];
        result.push('');
      }
      result.push(line);
    }
  }

  return result.join('\n');
}
