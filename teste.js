// teste.js
// Node/Bun script equivalente ao curl da NVIDIA.
// Uso: set NVIDIA_API_KEY no ambiente e execute com `node teste.js` ou `bun run teste.js`.

import { TextDecoder } from 'util';

const API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const apiKey = process.env.NVIDIA_API_KEY || process.env.API_KEY;
if (!apiKey) {
  console.error('Erro: defina NVIDIA_API_KEY no ambiente');
  process.exit(1);
}

const body = {
  model: 'minimaxai/minimax-m2.7',
  messages: [
    { role: 'user', content: 'Olá' }
  ],
  temperature: 1,
  top_p: 0.95,
  max_tokens: 8192,
  stream: true
};

async function run() {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error('HTTP', res.status, txt);
    process.exit(1);
  }

  if (!res.body) {
    console.error('Resposta não veio com body');
    process.exit(1);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });

    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      // NVIDIA SSE typically prefixes chunks with "data:"
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          console.log('\n[STREAM DONE]');
          return;
        }
        try {
          const obj = JSON.parse(payload);
          // print raw chunk for inspection
          console.log(JSON.stringify(obj));
        } catch (e) {
          // not JSON, print raw
          console.log(payload);
        }
      } else {
        console.log(line);
      }
    }
  }
}

run().catch((err) => {
  console.error('Erro:', err?.message || err);
  process.exit(1);
});

