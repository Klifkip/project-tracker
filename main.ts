import { Hono } from 'hono'
import { serveStatic } from 'hono/bun' 
import { Redis } from '@upstash/redis'
import { logger } from 'hono/logger'
import { cors } from 'hono/cors' // FIX 1: Import CORS

const app = new Hono()

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})

app.use(logger())
app.use('/api/*', cors()) // FIX 1: Enable CORS to prevent 405 on OPTIONS preflight requests

// Serve frontend
app.get('/', async (c) => {
  const html = await Bun.file('./public/index.html').text()
  return c.html(html)
})

// --- Project API ---
app.get('/api/projects', async (c) => {
  const projects = await redis.get('project-tracker:projects')
  return c.json({ projects: projects || [] })
})

// FIX 2: Handle both POST and PUT methods just in case frontend uses PUT for updates
const handleProjectSave = async (c: any) => {
  const body = await c.req.json()
  await redis.set('project-tracker:projects', body.projects)
  return c.json({ ok: true })
}
app.post('/api/projects', handleProjectSave)
app.put('/api/projects', handleProjectSave)

// --- Chat API ---
app.get('/api/chat', async (c) => {
  const nodeId = c.req.query('nodeId')
  if (!nodeId) return c.json({ ok: false, error: 'Missing nodeId' }, 400)

  const messages = await redis.lrange(`chat:${nodeId}`, 0, 100)
  
  const parsedMessages = messages.map(m => 
    typeof m === 'string' ? JSON.parse(m) : m
  )
  
  return c.json({ ok: true, messages: parsedMessages.reverse() })
})

// FIX 2: Handle both POST and PUT for chat
const handleChatSave = async (c: any) => {
  const nodeId = c.req.query('nodeId')
  const body = await c.req.json()

  if (!nodeId || !body.text) return c.json({ ok: false, error: 'Missing nodeId or text' }, 400)

  const payload = JSON.stringify({
    text: body.text,
    sender: body.sender || 'Anonymous', 
    timestamp: Date.now()
  })

  await redis.lpush(`chat:${nodeId}`, payload)
  return c.json({ ok: true })
}
app.post('/api/chat', handleChatSave)
app.put('/api/chat', handleChatSave)

// --- Schedule API ---
app.get('/api/schedule', async (c) => {
  const projectId = c.req.query('projectId') || 'global';
  const data = await redis.get(`schedule:${projectId}`);
  return c.json({ content: data || "" });
});

const handleScheduleSave = async (c: any) => {
  const projectId = c.req.query('projectId') || 'global';
  const body = await c.req.json();
  await redis.set(`schedule:${projectId}`, body.content);
  return c.json({ ok: true });
};
app.post('/api/schedule', handleScheduleSave)
app.put('/api/schedule', handleScheduleSave)

// --- Google Drive Upload API ---
interface GoogleDriveResponse {
  id: string;
  name: string;
  webViewLink: string;
}

interface FileMetadata {
  fileId: string;
  fileName: string;
  link: string;
  nodeId: string;
  projectId: string;
  timestamp: number;
}

async function getGoogleAccessToken(): Promise<string> {
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!;
  const serviceAccountKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY!;
  const privateKeyId = process.env.GOOGLE_PRIVATE_KEY_ID!;

  const header = {
    alg: 'RS256',
    typ: 'JWT',
    kid: privateKeyId
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceAccountEmail,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  const headerEncoded = Bun.base64.encode(JSON.stringify(header));
  const payloadEncoded = Bun.base64.encode(JSON.stringify(payload));
  const signature = await generateSignature(
    `${headerEncoded}.${payloadEncoded}`,
    serviceAccountKey
  );

  const jwt = `${headerEncoded}.${payloadEncoded}.${signature}`;

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });

  const tokenData = await tokenResponse.json() as any;
  if (!tokenData.access_token) {
    throw new Error('Failed to get Google access token');
  }

  return tokenData.access_token;
}

async function generateSignature(data: string, privateKey: string): Promise<string> {
  const key = privateKey.replace(/\\n/g, '\n');
  
  const keyObject = await crypto.subtle.importKey(
    'pkcs8',
    Buffer.from(
      key
        .replace('-----BEGIN PRIVATE KEY-----', '')
        .replace('-----END PRIVATE KEY-----', '')
        .replace(/\n/g, ''),
      'base64'
    ),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    keyObject,
    Buffer.from(data)
  );

  return Bun.base64.encode(signatureBuffer).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

app.post('/api/upload', async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File;
    const nodeId = formData.get('nodeId') as string;
    const projectId = formData.get('projectId') as string;

    if (!file || !nodeId || !projectId) {
      return c.json({ error: 'Missing required fields' }, 400);
    }

    const accessToken = await getGoogleAccessToken();
    const driveFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID!;

    const fileName = `${projectId}_${nodeId}_${Date.now()}_${file.name}`;
    const fileContent = await file.arrayBuffer();

    const driveMetadata = {
      name: fileName,
      parents: [driveFolderId]
    };

    const boundary = '===============7330845974216740156==';
    const body = new Uint8Array();

    const textPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(driveMetadata)}\r\n--${boundary}\r\nContent-Type: ${file.type}\r\n\r\n`;
    const endPart = `\r\n--${boundary}--`;

    const textEncoder = new TextEncoder();
    const parts = [
      textEncoder.encode(textPart),
      new Uint8Array(fileContent),
      textEncoder.encode(endPart)
    ];

    const totalLength = parts.reduce((acc, part) => acc + part.length, 0);
    const multipartBody = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      multipartBody.set(part, offset);
      offset += part.length;
    }

    const uploadResponse = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': `multipart/related; boundary="${boundary}"`
        },
        body: multipartBody
      }
    );

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      console.error('Google Drive upload failed:', errorText);
      return c.json({ error: 'Upload to Google Drive failed' }, 500);
    }

    const driveFile = await uploadResponse.json() as GoogleDriveResponse;

    try {
      await fetch(`https://www.googleapis.com/drive/v3/files/${driveFile.id}/permissions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          role: 'reader',
          type: 'anyone'
        })
      });
    } catch (e) {
      console.error('Failed to set public permissions:', e);
    }

    const fileMetadata: FileMetadata = {
      fileId: driveFile.id,
      fileName: driveFile.name,
      link: driveFile.webViewLink,
      nodeId,
      projectId,
      timestamp: Date.now()
    };

    await redis.lpush(`files:${nodeId}`, JSON.stringify(fileMetadata));

    return c.json({
      success: true,
      fileId: driveFile.id,
      fileName: driveFile.name,
      link: driveFile.webViewLink,
      embedLink: `https://drive.google.com/file/d/${driveFile.id}/preview`
    });

  } catch (error) {
    console.error('Upload error:', error);
    return c.json({ 
      error: error instanceof Error ? error.message : 'Upload failed' 
    }, 500);
  }
});

// Get files for a node
app.get('/api/files/:nodeId', async (c) => {
  const nodeId = c.req.param('nodeId');
  if (!nodeId) return c.json({ ok: false }, 400);

  const files = await redis.lrange(`files:${nodeId}`, 0, 100);
  const parsedFiles = files.map(f => 
    typeof f === 'string' ? JSON.parse(f) : f
  );

  return c.json({ ok: true, files: parsedFiles.reverse() });
});

// FIX 3: API Catch-All
// If an API route gets hit with a bad method (like an unhandled DELETE) or doesn't exist,
// this ensures the server sends back JSON instead of falling through to serveStatic,
// which returns HTML and crashes the frontend with the `<!DOCTYPE...` error.
app.all('/api/*', (c) => {
  return c.json({ ok: false, error: 'API route or method not found' }, 405)
})

// Serve static files (CSS, JS, images)
app.use('/*', serveStatic({ root: './public' }))

export default app
