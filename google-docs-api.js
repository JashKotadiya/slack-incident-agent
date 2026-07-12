import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

export async function exportToGoogleDoc(incidentTitle, markdownSummary, userEmail) {
  // Check if credentials exist in .env or as a file
  let credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const documentId = process.env.GOOGLE_DOC_ID;
  
  if (!credentialsPath || !documentId) {
    throw new Error("Missing Google API Credentials or GOOGLE_DOC_ID in .env!");
  }

  // Resolve absolute path if needed
  credentialsPath = path.resolve(process.cwd(), credentialsPath);

  if (!fs.existsSync(credentialsPath)) {
    throw new Error(`Credential file not found at ${credentialsPath}`);
  }

  // Authenticate
  const auth = new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: [
      'https://www.googleapis.com/auth/documents'
    ],
  });

  const docs = google.docs({ version: 'v1', auth });

  try {
    const formattedDate = new Date().toISOString().split('T')[0];
    const header = `\n\n=================================\nINCIDENT REPORT: ${incidentTitle} - ${formattedDate}\n=================================\n\n`;
    
    // Insert the summary text at the beginning of the document
    await docs.documents.batchUpdate({
      documentId: documentId,
      requestBody: {
        requests: [
          {
            insertText: {
              location: {
                index: 1, // Insert at the very beginning of the document
              },
              text: header + markdownSummary
            }
          }
        ]
      }
    });

    return `https://docs.google.com/document/d/${documentId}/edit`;
  } catch (error) {
    console.error("Error updating Google Doc:", error);
    throw error;
  }
}
