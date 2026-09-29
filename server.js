import express from 'express';
import fetch from 'node-fetch';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { enqueueMetaLead, flushMetaTasks } from './meta-capi.js';

const app = express();
const PORT = process.env.PORT || 3000;

let fetchImpl = fetch;

export function setFetchForTests(nextFetch) {
  fetchImpl = nextFetch;
}

export { app, flushMetaTasks };

const LANDING_ORIGINS = [
  'https://www.javer-queretaro.com',
  'https://javer-queretaro.com'
];

function isAllowedOrigin(origin) {
  if (!origin) return false;

  const configuredOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((item) => item.trim().replace(/\/$/, ''))
    .filter(Boolean);

  if (!configuredOrigins.length) return true;
  return configuredOrigins.includes(origin) || LANDING_ORIGINS.includes(origin);
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://www.google.com");

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  next();
});

app.use(express.json());

app.get('/', (req, res) => {
  res.status(200).send('OK');
});

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || '';
}

app.post('/enviar', async (req, res) => {
  try {
    const body = req.body || {};

    const nameRegex = /^[a-zA-ZáéíóúÁÉÍÓÚñÑ\s]{4,}$/;
    if (!nameRegex.test(body.first_name || '')) {
      return res.status(400).json({ error: 'Nombre inválido. Usa solo letras y al menos 4 caracteres.' });
    }

    const phoneRegex = /^[0-9]{8,10}$/;
    if (!phoneRegex.test(body.phone || '')) {
      return res.status(400).json({ error: 'Teléfono inválido. Debe contener solo números y de 8 a 10 dígitos.' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(body.email || '')) {
      return res.status(400).json({ error: 'Correo electrónico inválido.' });
    }

    const requiredFields = [
      'first_name',
      'phone',
      'email',
      '00N3l00000Q7A54',
      '00N3l00000Q7A57',
      '00N3l00000Q7A4k',
      '00N3l00000Q7A4n',
      '00N3l00000Q7A5S'
    ];

    for (const field of requiredFields) {
      if (!body[field]) {
        return res.status(400).json({ error: `El campo ${field} es obligatorio.` });
      }
    }

    const recaptchaToken = body['g-recaptcha-response'];
    if (!recaptchaToken) {
      return res.status(400).json({ error: 'No reCAPTCHA token' });
    }

    if (!body.aviso || !(body.aviso === true || body.aviso === 'true' || body.aviso === 'on')) {
      return res.status(400).json({ error: 'Debes aceptar el aviso de privacidad.' });
    }

    const secretKey = process.env.RECAPTCHA_SECRET || '6LeYyF4rAAAAAB2gm91IIiD9RQYgSkBrbkkkpWSy';
    const params = new URLSearchParams();
    params.append('secret', secretKey);
    params.append('response', recaptchaToken);

    const recaptchaRes = await fetchImpl('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      body: params
    });

    const recaptchaJson = await recaptchaRes.json();
    if (!recaptchaJson.success) {
      return res.status(403).json({ error: 'reCAPTCHA inválido' });
    }

    const salesforceUrl = 'https://webto.salesforce.com/servlet/servlet.WebToLead?encoding=UTF-8';
    const salesforceData = new URLSearchParams({
      oid: '00Do0000000b6Io',
      first_name: body.first_name,
      phone: body.phone,
      email: body.email,
      '00N3l00000Q7A54': body['00N3l00000Q7A54'],
      '00N3l00000Q7A57': body['00N3l00000Q7A57'],
      '00N3l00000Q7A4k': body['00N3l00000Q7A4k'],
      '00N3l00000Q7A4n': body['00N3l00000Q7A4n'],
      '00N3l00000Q7A5S': body['00N3l00000Q7A5S']
    });

    const salesforceResponse = await fetchImpl(salesforceUrl, {
      method: 'POST',
      body: salesforceData,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (!salesforceResponse.ok) {
      return res.status(500).json({ error: 'Error al enviar a Salesforce' });
    }

    const eventId = crypto.randomUUID();
    enqueueMetaLead({
      eventId,
      formOrigen: body.form_origen,
      email: body.email,
      phone: body.phone,
      ip: clientIp(req),
      userAgent: req.get('user-agent') || '',
      fbp: body.fbp,
      fbc: body.fbc,
      eventSourceUrl: body.event_source_url
    }, fetchImpl);

    return res.status(200).json({
      message: 'Formulario enviado correctamente',
      event_id: eventId
    });
  } catch (error) {
    console.error('Error en /enviar:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export function startServer() {
  return app.listen(PORT, () => {
    console.log(`Backend escuchando en http://localhost:${PORT}`);
  });
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  const entryUrl = pathToFileURL(path.resolve(entry)).href;
  const selfUrl = pathToFileURL(fileURLToPath(import.meta.url)).href;
  return entryUrl === selfUrl;
}

if (isDirectRun()) {
  startServer();
}
