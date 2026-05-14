import { Hono } from 'hono'
import { serveStatic } from 'hono/bun' 
import { Redis } from '@upstash/redis'
import { logger } from 'hono/logger'

const app = new Hono()

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})

app.use(logger())

// Serve frontend
app.get('/', async (c) => {
  const html = await Bun.file('./public/index.html').text()
  return c.html(html)
})

// --- Project API ---
// Updated to match the key 'project-tracker:projects' from your screenshot
app.get('/api/projects', async (c) => {
  const projects = await redis.get('project-tracker:projects')
  return c.json({ projects: projects || [] })
})

app.post('/api/projects', async (c) => {
  const body = await c.req.json()
  await redis.set('project-tracker:projects', body.projects)
  return c.json({ ok: true })
})

// --- Chat API ---
app.get('/api/chat', async (c) => {
  const nodeId = c.req.query('nodeId')
  if (!nodeId) return c.json({ ok: false }, 400)

  // In image_bbf9c1.png, we see 'chat:r1', so this format is perfect
  const messages = await redis.lrange(`chat:${nodeId}`, 0, 100)
  return c.json({ ok: true, messages: messages.reverse() })
})

app.post('/api/chat', async (c) => {
  const nodeId = c.req.query('nodeId')
  const body = await c.req.json()

  if (!nodeId || !body.text) return c.json({ ok: false }, 400)

  const payload = JSON.stringify({
    text: body.text,
    timestamp: Date.now()
  })

  await redis.lpush(`chat:${nodeId}`, payload)
  return c.json({ ok: true })
})

// --- Schedule API ---
app.get('/api/schedule', async (c) => {
  const projectId = c.req.query('projectId') || 'global';
  const data = await redis.get(`schedule:${projectId}`);
  return c.json({ content: data || "" });
});

app.post('/api/schedule', async (c) => {
  const projectId = c.req.query('projectId') || 'global';
  const body = await c.req.json();
  await redis.set(`schedule:${projectId}`, body.content);
  return c.json({ ok: true });
});

export default app