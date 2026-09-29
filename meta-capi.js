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

    if (typeof response.text === 'function') {
      await response.text().catch(() => {});
    }

    if (!response.ok) {
      logMeta('Meta CAPI error', { event_id: eventId, status: response.status });
      return { ok: false, status: response.status };
    }

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
