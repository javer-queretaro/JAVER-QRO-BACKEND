import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  app,
  flushMetaTasks,
  setFetchForTests
} from '../server.js';
import { normalizePhone, sha256 } from '../meta-capi.js';

const ENV_KEYS = [
  'META_PIXEL_ID',
  'META_ACCESS_TOKEN',
  'META_GRAPH_API_VERSION',
  'META_TEST_EVENT_CODE'
];

const calls = [];
const previousEnv = {};
let server;
let baseUrl;
let MetaLead;

function loadMetaLead() {
  const helperPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../javer-queretaro-frontend/public/meta-lead.js'
  );
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(helperPath, 'utf8'), sandbox);
  return sandbox.MetaLead;
}

function installFetch({ recaptchaSuccess = true, salesforceOk = true, meta = {} } = {}) {
  calls.length = 0;
  setFetchForTests(async (url, options) => {
    const target = String(url);
    calls.push({ url: target, options });

    if (target.includes('siteverify')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: recaptchaSuccess })
      };
    }

    if (target.includes('WebToLead')) {
      return {
        ok: salesforceOk,
        status: salesforceOk ? 200 : 500,
        text: async () => ''
      };
    }

    if (target.includes('graph.facebook.com')) {
      if (meta.throw) {
        throw new Error('meta down');
      }
      const status = meta.status ?? 200;
      const body = typeof meta.body === 'string'
        ? meta.body
        : status >= 200 && status < 300
          ? JSON.stringify({ events_received: 1, messages: [], fbtrace_id: 'trace-ok' })
          : JSON.stringify({
            error: {
              message: 'Invalid token test-meta-token for juan.perez@example.com',
              type: 'OAuthException',
              code: 190,
              fbtrace_id: 'trace-err'
            }
          });
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => body
      };
    }

    throw new Error(`Unexpected fetch ${target}`);
  });
}

function graphCalls() {
  return calls.filter((call) => call.url.includes('graph.facebook.com'));
}

function graphPayload(index = 0) {
  return JSON.parse(graphCalls()[index].options.body);
}

function validBody(formOrigen, extras = {}) {
  return {
    first_name: 'Juan Perez',
    phone: '4421234567',
    email: 'Juan.Perez@Example.com',
    '00N3l00000Q7A54': 'VALVENTO',
    '00N3l00000Q7A57': 'Landing_Querétaro',
    '00N3l00000Q7A4k': 'Información',
    '00N3l00000Q7A4n': 'Medios Digitales',
    '00N3l00000Q7A5S': 'Micrositios',
    'g-recaptcha-response': 'token-ok',
    aviso: true,
    form_origen: formOrigen,
    event_source_url: 'https://javer-queretaro.com/?utm=test',
    fbp: 'fb.1.1596403881668.1116446470',
    fbc: 'fb.1.1554763741205.AbCdEfGhIjKl',
    ...extras
  };
}

async function postLead(body) {
  const response = await fetch(`${baseUrl}/enviar`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://localhost:8080',
      'User-Agent': 'TestAgent/1.0',
      'X-Forwarded-For': '203.0.113.10'
    },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  await flushMetaTasks();
  return { status: response.status, json };
}

function assertNoSensitiveLogs(entries) {
  const serialized = JSON.stringify(entries);
  assert.equal(serialized.includes('Juan.Perez@Example.com'), false);
  assert.equal(serialized.includes('juan.perez@example.com'), false);
  assert.equal(serialized.includes('4421234567'), false);
  assert.equal(serialized.includes('test-meta-token'), false);
  assert.equal(serialized.includes('203.0.113.10'), false);
}

function assertSalesforceUntouched() {
  const salesforceCall = calls.find((call) => call.url.includes('WebToLead'));
  assert.ok(salesforceCall);
  assert.equal(
    salesforceCall.url,
    'https://webto.salesforce.com/servlet/servlet.WebToLead?encoding=UTF-8'
  );
  const sent = salesforceCall.options.body;
  assert.equal(sent.get('oid'), '00Do0000000b6Io');
  assert.equal(sent.get('first_name'), 'Juan Perez');
  assert.equal(sent.get('phone'), '4421234567');
  assert.equal(sent.get('email'), 'Juan.Perez@Example.com');
  assert.equal(sent.get('00N3l00000Q7A54'), 'VALVENTO');
  assert.equal(sent.get('form_origen'), null);
  assert.equal(sent.get('fbp'), null);
  assert.equal(sent.get('fbc'), null);
  assert.equal(sent.get('event_source_url'), null);
}

function assertSharedEventId(formOrigen, responseJson) {
  const payload = graphPayload();
  const event = payload.data[0];
  assert.equal(payload.access_token, 'test-meta-token');
  assert.equal(event.event_name, 'Lead');
  assert.equal(event.action_source, 'website');
  assert.equal(event.event_id, responseJson.event_id);
  assert.equal(event.custom_data.form_name, `javer_qro_${formOrigen}`);
  assert.equal(graphCalls()[0].url.includes('access_token'), false);
  assert.equal(
    graphCalls()[0].url,
    'https://graph.facebook.com/v25.0/1835121900692523/events'
  );

  const pixelCalls = [];
  const tracked = MetaLead.trackLead(
    (command, eventName, customData, options) => {
      pixelCalls.push({ command, eventName, customData, options });
    },
    formOrigen,
    responseJson
  );

  assert.equal(pixelCalls.length, 1);
  assert.equal(pixelCalls[0].command, 'track');
  assert.equal(pixelCalls[0].eventName, 'Lead');
  assert.equal(pixelCalls[0].options.eventID, event.event_id);
  assert.equal(pixelCalls[0].customData.form_name, event.custom_data.form_name);
  assert.equal(tracked.eventID, responseJson.event_id);
  return event;
}

before(async () => {
  MetaLead = loadMetaLead();
  for (const key of ENV_KEYS) previousEnv[key] = process.env[key];
  process.env.META_PIXEL_ID = '1835121900692523';
  process.env.META_ACCESS_TOKEN = 'test-meta-token';
  process.env.META_GRAPH_API_VERSION = 'v25.0';
  delete process.env.META_TEST_EVENT_CODE;

  server = await new Promise((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

test('lead-form-1 exitoso', async () => {
  installFetch();
  const { status, json } = await postLead(validBody('lead-form-1'));

  assert.equal(status, 200);
  assert.equal(json.message, 'Formulario enviado correctamente');
  assert.equal(typeof json.event_id, 'string');
  assertSalesforceUntouched();
  assert.equal(graphCalls().length, 1);

  const event = assertSharedEventId('lead-form-1', json);
  assert.equal(event.user_data.em[0], sha256('juan.perez@example.com'));
  assert.equal(event.user_data.ph[0], sha256(normalizePhone('4421234567')));
  assert.equal(normalizePhone('4421234567'), '524421234567');
  assert.equal(event.user_data.client_ip_address, '203.0.113.10');
  assert.equal(event.user_data.client_user_agent, 'TestAgent/1.0');
  assert.equal(event.user_data.fbp, 'fb.1.1596403881668.1116446470');
  assert.equal(event.user_data.fbc, 'fb.1.1554763741205.AbCdEfGhIjKl');
  assert.equal(event.user_data.fn, undefined);
  assert.equal(event.event_source_url, 'https://javer-queretaro.com/?utm=test');
  assert.equal(graphPayload().test_event_code, undefined);
});

test('lead-form-2 exitoso', async () => {
  installFetch();
  const { status, json } = await postLead(validBody('lead-form-2', {
    fbp: 'not-valid',
    '00N3l00000Q7A54': 'MASSARO'
  }));

  assert.equal(status, 200);
  assert.equal(json.message, 'Formulario enviado correctamente');
  const event = assertSharedEventId('lead-form-2', json);
  assert.equal(event.custom_data.form_name, 'javer_qro_lead-form-2');
  assert.equal(event.user_data.fbp, undefined);
  assert.equal(event.user_data.fbc, 'fb.1.1554763741205.AbCdEfGhIjKl');
  assert.equal(calls.find((call) => call.url.includes('WebToLead')).options.body.get('00N3l00000Q7A54'), 'MASSARO');
});

test('error de validación', async () => {
  installFetch();
  const pixelCalls = [];
  const { status, json } = await postLead(validBody('lead-form-1', { first_name: 'Jo' }));

  assert.equal(status, 400);
  assert.equal(json.event_id, undefined);
  assert.equal(calls.length, 0);
  assert.equal(graphCalls().length, 0);
  assert.equal(
    MetaLead.trackLead(() => pixelCalls.push('lead'), 'lead-form-1', json),
    null
  );
  assert.equal(pixelCalls.length, 0);
});

test('error de reCAPTCHA', async () => {
  installFetch({ recaptchaSuccess: false });
  const pixelCalls = [];
  const { status, json } = await postLead(validBody('lead-form-2'));

  assert.equal(status, 403);
  assert.equal(json.error, 'reCAPTCHA inválido');
  assert.equal(json.event_id, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.includes('siteverify'), true);
  assert.equal(graphCalls().length, 0);
  assert.equal(MetaLead.trackLead(() => pixelCalls.push('lead'), 'lead-form-2', json), null);
  assert.equal(pixelCalls.length, 0);
});

test('error de Salesforce', async () => {
  installFetch({ salesforceOk: false });
  const pixelCalls = [];
  const { status, json } = await postLead(validBody('lead-form-1'));

  assert.equal(status, 500);
  assert.equal(json.error, 'Error al enviar a Salesforce');
  assert.equal(json.event_id, undefined);
  assert.equal(calls.some((call) => call.url.includes('WebToLead')), true);
  assert.equal(graphCalls().length, 0);
  assert.equal(MetaLead.trackLead(() => pixelCalls.push('lead'), 'lead-form-1', json), null);
  assert.equal(pixelCalls.length, 0);
});

test('error de Conversions API', async () => {
  const originalError = console.error;
  const entries = [];
  console.error = (...args) => {
    entries.push(args);
  };

  try {
    installFetch({ meta: { status: 500 } });
    const failedHttp = await postLead(validBody('lead-form-1'));
    assert.equal(failedHttp.status, 200);
    assert.equal(failedHttp.json.message, 'Formulario enviado correctamente');
    assert.equal(graphPayload().data[0].event_id, failedHttp.json.event_id);
    assert.equal(entries.some((entry) => (
      entry[0] === 'Meta CAPI error' &&
      entry[1].status === 500 &&
      entry[1].event_id === failedHttp.json.event_id &&
      entry[1].error_code === 190 &&
      entry[1].error_type === 'OAuthException' &&
      entry[1].fbtrace_id === 'trace-err'
    )), true);
    assert.equal(JSON.stringify(entries).includes('Invalid token'), false);

    installFetch({ meta: { throw: true } });
    const failedNetwork = await postLead(validBody('lead-form-2'));
    assert.equal(failedNetwork.status, 200);
    assert.equal(failedNetwork.json.message, 'Formulario enviado correctamente');
    assert.equal(graphCalls().length, 1);
    assert.equal(entries.some((entry) => entry[1]?.reason === 'request_failed'), true);

    delete process.env.META_ACCESS_TOKEN;
    installFetch();
    const missingConfig = await postLead(validBody('lead-form-1'));
    assert.equal(missingConfig.status, 200);
    assert.equal(missingConfig.json.message, 'Formulario enviado correctamente');
    assert.equal(graphCalls().length, 0);
    assert.equal(entries.some((entry) => entry[1]?.reason === 'missing_config'), true);
    process.env.META_ACCESS_TOKEN = 'test-meta-token';

    assertNoSensitiveLogs(entries);
  } finally {
    console.error = originalError;
    process.env.META_ACCESS_TOKEN = 'test-meta-token';
  }
});

test('registro de éxito y error de Meta', async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const logs = [];
  const errors = [];
  console.log = (...args) => logs.push(args);
  console.error = (...args) => errors.push(args);

  try {
    installFetch();
    const success = await postLead(validBody('lead-form-1'));
    const successEntry = logs.find((entry) => entry[0] === 'Meta CAPI success');
    assert.ok(successEntry);
    assert.equal(successEntry[1].event_id, success.json.event_id);
    assert.equal(successEntry[1].status, 200);
    assert.equal(successEntry[1].events_received, 1);
    assert.equal(successEntry[1].fbtrace_id, 'trace-ok');
    assert.equal(errors.some((entry) => entry[0] === 'Meta CAPI error'), false);

    installFetch({
      meta: {
        status: 400,
        body: JSON.stringify({
          error: {
            message: 'access token test-meta-token email juan.perez@example.com phone 4421234567',
            type: 'OAuthException',
            code: 190,
            fbtrace_id: 'trace-bad'
          }
        })
      }
    });
    const failed = await postLead(validBody('lead-form-2'));
    const errorEntry = errors.find((entry) => entry[0] === 'Meta CAPI error' && entry[1].status === 400);
    assert.equal(failed.status, 200);
    assert.ok(errorEntry);
    assert.equal(errorEntry[1].event_id, failed.json.event_id);
    assert.equal(errorEntry[1].error_code, 190);
    assert.equal(errorEntry[1].fbtrace_id, 'trace-bad');
    assert.equal(logs.filter((entry) => entry[0] === 'Meta CAPI success' && entry[1].event_id === failed.json.event_id).length, 0);

    assertNoSensitiveLogs([...logs, ...errors]);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test('doble envío', async () => {
  installFetch();
  const guard = MetaLead.createSubmitGuard();
  let networkSends = 0;

  async function submitOnce() {
    if (!guard.tryAcquire()) return null;
    try {
      networkSends += 1;
      return await postLead(validBody('lead-form-1'));
    } finally {
      guard.release();
    }
  }

  const firstPromise = submitOnce();
  const duplicate = await submitOnce();
  const first = await firstPromise;

  assert.equal(duplicate, null);
  assert.equal(networkSends, 1);
  assert.equal(graphCalls().length, 1);
  assert.equal(graphPayload().data[0].event_id, first.json.event_id);

  const second = await submitOnce();
  assert.equal(networkSends, 2);
  assert.notEqual(second.json.event_id, first.json.event_id);
  assert.equal(graphCalls().length, 2);
  assert.equal(graphPayload(0).data[0].event_id, first.json.event_id);
  assert.equal(graphPayload(1).data[0].event_id, second.json.event_id);
});

test('preflight OPTIONS de la landing', async () => {
  const previousOrigins = process.env.ALLOWED_ORIGINS;
  process.env.ALLOWED_ORIGINS = 'https://javer-queretaro.com';
  installFetch();

  try {
    const response = await fetch(`${baseUrl}/enviar`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://www.javer-queretaro.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type'
      }
    });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://www.javer-queretaro.com');
    assert.match(response.headers.get('access-control-allow-methods'), /POST/);
    assert.match(response.headers.get('access-control-allow-methods'), /OPTIONS/);
    assert.match(response.headers.get('access-control-allow-headers'), /Content-Type/i);
    assert.equal(calls.length, 0);

    const apex = await fetch(`${baseUrl}/enviar`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://javer-queretaro.com',
        'Access-Control-Request-Method': 'POST'
      }
    });
    assert.equal(apex.status, 204);
    assert.equal(apex.headers.get('access-control-allow-origin'), 'https://javer-queretaro.com');

    const blocked = await fetch(`${baseUrl}/enviar`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST'
      }
    });
    assert.equal(blocked.status, 204);
    assert.equal(blocked.headers.get('access-control-allow-origin'), null);
  } finally {
    if (previousOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = previousOrigins;
  }
});

test('mismo event_id entre Pixel y CAPI', async () => {
  installFetch();
  const first = await postLead(validBody('lead-form-1'));
  const firstEventId = graphPayload().data[0].event_id;
  assertSharedEventId('lead-form-1', first.json);

  installFetch();
  const second = await postLead(validBody('lead-form-2'));
  assertSharedEventId('lead-form-2', second.json);
  assert.notEqual(first.json.event_id, second.json.event_id);
  assert.equal(firstEventId, first.json.event_id);

  assert.equal(normalizePhone('12345678'), '12345678');
  const withoutBrowserIds = MetaLead.resolveFbc({ fbcCookie: '', fbclid: '' });
  assert.equal(withoutBrowserIds, '');
  const fromClick = MetaLead.resolveFbc({
    fbcCookie: '',
    fbclid: 'IwAR0click',
    timestamp: 1554763741205
  });
  assert.equal(fromClick, 'fb.1.1554763741205.IwAR0click');
  assert.equal(
    MetaLead.resolveFbc({ fbcCookie: 'fb.1.1.existing', fbclid: 'ignored', timestamp: 1 }),
    'fb.1.1.existing'
  );
  assert.equal(MetaLead.shouldTrackLead({ error: 'Teléfono inválido' }), false);
  assert.equal(MetaLead.shouldTrackLead({ message: 'Formulario enviado correctamente' }), false);
});
