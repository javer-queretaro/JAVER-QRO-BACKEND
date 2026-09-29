import crypto from 'node:crypto';

const DEFAULT_GRAPH_VERSION = 'v25.0';
const FORM_NAMES = {
  'lead-form-1': 'javer_qro_lead-form-1',
  'lead-form-2': 'javer_qro_lead-form-2'
};

const metaTasks = new Set();

export function formNameFromOrigen(formOrigen) {
  return FORM_NAMES[formOrigen] || '';
}

export function normalizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

export function normalizePhone(phone) {
  if (phone === undefined || phone === null) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `52${digits}`;
  return digits;
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function browserId(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512) return '';
  if (!/^fb\.\d+\./.test(trimmed)) return '';
  return trimmed;
}

function eventSourceUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2000) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString();
  } catch {
    return '';
  }
}

function graphVersion() {
  const configured = (process.env.META_GRAPH_API_VERSION || '').trim();
  if (/^v\d+\.\d+$/.test(configured)) return configured;
  return DEFAULT_GRAPH_VERSION;
}

function logMeta(message, details) {
  console.error(message, details);
}

function readSafeId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) return null;
  return value;
}

function safeMetaResult(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { events_received: null, fbtrace_id: null, error_code: null, error_type: null };
  }

  const error = parsed.error && typeof parsed.error === 'object' ? parsed.error : null;
  return {
    events_received: Number.isFinite(parsed.events_received) ? parsed.events_received : null,
    fbtrace_id: readSafeId(parsed.fbtrace_id) || readSafeId(error?.fbtrace_id),
    error_code: error && Number.isFinite(error.code) ? error.code : null,
    error_type: readSafeId(error?.type)
  };
}

async function readMetaResult(response) {
  if (typeof response.text !== 'function') return safeMetaResult(null);
  const raw = await response.text().catch(() => '');
  if (!raw) return safeMetaResult(null);
  try {
    return safeMetaResult(JSON.parse(raw));
  } catch {
    return safeMetaResult(null);
  }
}

export async function sendMetaLeadEvent(input, fetchImpl) {
  const eventId = input.eventId;
  const pixelId = (process.env.META_PIXEL_ID || '').trim();
  const accessToken = (process.env.META_ACCESS_TOKEN || '').trim();

  if (!/^\d+$/.test(pixelId) || !accessToken) {
    logMeta('Meta CAPI skipped', { event_id: eventId, reason: 'missing_config' });
    return { skipped: true };
  }

  const userData = {};
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);
  if (email) userData.em = [sha256(email)];
  if (phone) userData.ph = [sha256(phone)];
  if (input.ip) userData.client_ip_address = input.ip;
  if (input.userAgent) userData.client_user_agent = input.userAgent;

  const fbp = browserId(input.fbp);
  const fbc = browserId(input.fbc);
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;

  const event = {
    event_name: 'Lead',
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    action_source: 'website',
    user_data: userData
  };

  const sourceUrl = eventSourceUrl(input.eventSourceUrl);
  if (sourceUrl) event.event_source_url = sourceUrl;

  const formName = formNameFromOrigen(input.formOrigen);
  if (formName) event.custom_data = { form_name: formName };

  const body = {
    data: [event],
    access_token: accessToken
  };

  const testEventCode = (process.env.META_TEST_EVENT_CODE || '').trim();
  if (testEventCode) body.test_event_code = testEventCode;

  const version = graphVersion();
  const url = `https://graph.facebook.com/${version}/${pixelId}/events`;

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const result = await readMetaResult(response);
    const summary = {
      event_id: eventId,
      status: response.status,
      events_received: result.events_received,
      fbtrace_id: result.fbtrace_id
    };

    if (!response.ok || result.events_received === 0) {
      logMeta('Meta CAPI error', {
        ...summary,
        error_code: result.error_code,
        error_type: result.error_type
      });
      return { ok: false, status: response.status };
    }

    console.log('Meta CAPI success', summary);
    return { ok: true };
  } catch {
    logMeta('Meta CAPI error', { event_id: eventId, reason: 'request_failed' });
    return { ok: false };
  }
}

export function enqueueMetaLead(input, fetchImpl) {
  const task = sendMetaLeadEvent(input, fetchImpl).catch(() => {});
  metaTasks.add(task);
  task.finally(() => {
    metaTasks.delete(task);
  });
  return task;
}

export function flushMetaTasks() {
  return Promise.allSettled([...metaTasks]);
}
