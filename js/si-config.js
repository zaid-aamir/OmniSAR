// SI Agent settings (js/siagent.js).
//
// proxyUrl: the address of OUR OWN proxy (a Cloudflare Worker kept outside this repo) that forwards
// a question to Grok. Leave it empty and the SI Agent uses only its pre-written offline answers
// (cases/<id>.si.json): no network call is made at all.
//
// This file must NEVER contain an API key, token or secret. The key lives only inside the Worker,
// as a secret its account owner sets with `npx wrangler secret put XAI_API_KEY`. The browser only
// ever talks to the proxy URL below.
export const SI_CONFIG = {
  proxyUrl: '',          // e.g. 'https://omnisar-si.<account>.workers.dev' once the Worker is deployed
  timeoutMs: 8000,       // no reply within 8 s -> show the offline answer instead
};
