const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, safeStorage } = require('electron');

const MODEL_ID = process.env.GEMINI_DIAG_MODEL || 'gemini-3.5-flash';
const CLODEX_API_URL = process.env.CLODEX_API_URL || 'https://clodex.xyz/api';
const CLODEX_LLM_RELAY_URL =
  process.env.CLODEX_LLM_RELAY_URL || 'https://clodex.xyz/v1';
const CLODEX_USER_DATA =
  process.env.CLODEX_DIAG_USER_DATA ||
  path.join(os.homedir(), 'Library/Application Support/clodex-dev');

if (!app || !safeStorage) {
  throw new Error(
    'This diagnostic must be run with Electron without ELECTRON_RUN_AS_NODE.',
  );
}

app.setPath('userData', CLODEX_USER_DATA);

function joinUrl(base, suffix) {
  return `${base.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`;
}

function readAuthSession() {
  const authPath = path.join(
    app.getPath('userData'),
    'clodex',
    'auth-session.json',
  );
  const buffer = fs.readFileSync(authPath);
  let content;
  try {
    content = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(buffer)
      : buffer.toString('utf8');
  } catch {
    content = buffer.toString('utf8');
  }
  const session = JSON.parse(content);
  if (!session?.token) throw new Error('No persisted Clodex auth token found.');
  return session;
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

function summarizeBody(body) {
  if (body == null) return '(empty)';
  if (typeof body === 'string') return body.slice(0, 1200);
  const choice = body.choices?.[0];
  const message = choice?.message;
  const content = message?.content;
  const error = body.error ?? body.errors;
  return JSON.stringify(
    {
      id: body.id,
      model: body.model,
      content:
        typeof content === 'string' ? content.slice(0, 500) : (content ?? null),
      finish_reason: choice?.finish_reason,
      error,
      provider_metadata: message?.provider_metadata,
    },
    null,
    2,
  );
}

async function getRuntimeToken(session) {
  const url = new URL(joinUrl(CLODEX_API_URL, '/ide/token'));
  if (session.activeKeyId) url.searchParams.set('keyId', session.activeKeyId);
  url.searchParams.set('provider', 'google');
  url.searchParams.set('modelId', MODEL_ID);
  url.searchParams.set('group', 'GEMINI');

  const body = {
    ...(session.activeKeyId ? { keyId: session.activeKeyId } : {}),
    provider: 'google',
    modelId: MODEL_ID,
    group: 'GEMINI',
  };
  const { response, body: data } = await requestJson(url.toString(), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok || !data?.token) {
    throw new Error(
      `Failed to get runtime token: HTTP ${response.status} ${summarizeBody(data)}`,
    );
  }
  return {
    token: data.token,
    keyId: data.keyId,
    keyName: data.keyName,
    group: data.group,
    expiresAt: data.expiresAt,
  };
}

async function chatCompletion(runtimeToken, label, payload) {
  const started = Date.now();
  const { response, body } = await requestJson(
    joinUrl(CLODEX_LLM_RELAY_URL, '/chat/completions'),
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${runtimeToken}`,
        'content-type': 'application/json',
        'x-clodex-client': 'manual-gemini-diagnostic',
      },
      body: JSON.stringify(payload),
    },
  );
  const elapsedMs = Date.now() - started;
  console.log(`\n[${label}] HTTP ${response.status} in ${elapsedMs}ms`);
  console.log(summarizeBody(body));
  return response.ok;
}

async function main() {
  await app.whenReady();
  try {
    const session = readAuthSession();
    console.log(
      `Using persisted Clodex session. activeKeyId=${session.activeKeyId ?? '(none)'}`,
    );
    const runtime = await getRuntimeToken(session);
    console.log(
      `Runtime token issued. keyName=${runtime.keyName ?? '(unknown)'} group=${runtime.group ?? '(unknown)'} keyId=${runtime.keyId ?? '(unknown)'}`,
    );

    const baseMessages = [
      {
        role: 'user',
        content: 'Reply with exactly: GEMINI_OK. No markdown, no explanation.',
      },
    ];

    await chatCompletion(runtime.token, 'simple no-tools', {
      model: MODEL_ID,
      messages: baseMessages,
      temperature: 0,
      max_tokens: 32,
      stream: false,
    });

    await chatCompletion(runtime.token, 'reasoning/options no-tools', {
      model: MODEL_ID,
      messages: baseMessages,
      temperature: 0,
      max_tokens: 64,
      stream: false,
      reasoning: { enabled: true, effort: 'medium' },
    });

    await chatCompletion(runtime.token, 'single tool', {
      model: MODEL_ID,
      messages: [
        {
          role: 'user',
          content: 'Use the provided tool to return the string GEMINI_TOOL_OK.',
        },
      ],
      temperature: 0,
      max_tokens: 128,
      stream: false,
      tools: [
        {
          type: 'function',
          function: {
            name: 'return_result',
            description: 'Return a diagnostic result string.',
            parameters: {
              type: 'object',
              properties: {
                value: { type: 'string' },
              },
              required: ['value'],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: 'auto',
    });
  } finally {
    app.quit();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  app?.quit();
  process.exitCode = 1;
});
