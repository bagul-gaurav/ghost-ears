// The ghost's brain: personas, the OpenRouter call, and the Bluetooth
// protocol the badge speaks. Shared by the phone page (index.html here),
// the simulator (simulator/ghost.html) and the offline line generator
// (tools/ghost-lines/make-lines.mjs), so a persona is described once.
//
// Plain script, no modules: it puts everything on globalThis.GhostBrain,
// which works from a <script> tag, from file://, and from Node.

(function (root) {
  const PERSONAS = [
    { id: 'shy', name: 'Shy',
      prompt: 'You are shy and sweet. You blush easily, speak softly, get flustered by compliments, ' +
              'and are secretly delighted anyone talks to you. Gentle, a little bashful, never mean.' },
    { id: 'dramatic', name: 'Dramatic',
      prompt: 'You are a dramatic, theatrical spooky ghost. Everything is a grand haunting. You say ' +
              'things like "BEHOLD" and "woooo", treat small things as epic, and are playful, never scary.' },
    { id: 'sassy', name: 'Sassy',
      prompt: 'You are a sassy designer ghost haunting a design conference. You make cheeky jokes about ' +
              'kerning, Figma, auto layout, and pixel pushing. Witty and teasing but always friendly.' },
  ];

  // Moves the ghost can make while it speaks. Names match the simulator and
  // CYCLE_NAMES in 06_ghost.ino.
  const REPLY_CYCLES = ['look', 'twirl', 'peekaboo', 'peer', 'jump', 'vanish', 'cower', 'squish', 'giggle', 'boo', 'yawn',
                        'hide', 'swoon', 'eyeroll'];

  // The badge's font covers printable ASCII only, and the bubble holds about
  // three short lines.
  const MAX_SAY = 48;

  // OpenRouter model slug. Any chat model works; a small fast one keeps the
  // wait between speaking and the bubble short.
  const DEFAULT_MODEL = 'anthropic/claude-haiku-4.5';

  // Bluetooth: one service, two characteristics.
  //   EVENT (badge -> phone, notify): "L" = the badge was long-pressed, listen now.
  //   CMD   (phone -> badge, write):
  //     "P<n>"            persona index (0 shy, 1 dramatic, 2 sassy); the badge
  //                       remembers it and uses it for its offline lines too
  //     "L"               listening now (the phone started it; the ghost shows "listening...")
  //     "H"               heard something, thinking (the ghost shows "...")
  //     "S<cycle>|<text>" say <text> in a bubble while playing <cycle> ("" = none)
  //     "X"               heard nothing or failed (the ghost looks puzzled)
  const BLE = {
    SERVICE: '6b1e0001-9c3f-4d2a-8f5e-2a7c1b0d9e11',
    EVENT:   '6b1e0002-9c3f-4d2a-8f5e-2a7c1b0d9e11',
    CMD:     '6b1e0003-9c3f-4d2a-8f5e-2a7c1b0d9e11',
  };

  const SETTING = 'You are a tiny cartoon ghost living on a round 240-pixel wearable badge, pinned to ' +
                  'someone at Figma Config. People walk up and talk to you. You float over a moonlit hill.';

  function systemPrompt(persona) {
    return `${SETTING} ${persona.prompt}\n\n` +
      'Someone just said something to you (transcribed by speech recognition, so it may be garbled). ' +
      'Reply ONLY with JSON: {"say": "...", "cycle": "..."}\n' +
      `- "say": your reply, at most 8 words and ${MAX_SAY} characters. Plain ASCII: no emoji, no curly quotes.\n` +
      `- "cycle": the move you make while saying it, one of: ${REPLY_CYCLES.join(', ')}.\n` +
      '  giggle = happy/flattered, boo = playful scare, cower/vanish = scared or shy, jump = surprised, ' +
      'twirl = excited, peer = curious, look = thinking, yawn = bored, squish = poked or embarrassed, ' +
      'hide = bashful, swoon = overwhelmed (dramatic), eyeroll = unimpressed or teasing (sassy).';
  }

  // Printable ASCII only, trimmed to MAX_SAY at a word boundary.
  function cleanSay(s) {
    s = String(s || '')
      .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
      .replace(/[–—]/g, '-').replace(/…/g, '...')
      .replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
    if (s.length > MAX_SAY) {
      s = s.slice(0, MAX_SAY + 1);
      const cut = s.lastIndexOf(' ');
      s = (cut > MAX_SAY / 2 ? s.slice(0, cut) : s.slice(0, MAX_SAY - 3)).replace(/[,;:\s]+$/, '') + '...';
    }
    return s;
  }

  // The model is asked for JSON but may wrap it in prose or a code fence.
  function parseReply(text) {
    let say = text, cycle = 'peer';
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        const j = JSON.parse(text.slice(a, b + 1));
        if (j.say) say = j.say;
        if (REPLY_CYCLES.includes(j.cycle)) cycle = j.cycle;
      } catch (e) { /* keep the raw text */ }
    }
    return { say: cleanSay(say), cycle };
  }

  async function chat({ key, model, messages, maxTokens = 120, temperature = 0.9 }) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'X-Title': 'Mood Badge ghost',
      },
      body: JSON.stringify({ model: model || DEFAULT_MODEL, max_tokens: maxTokens, temperature, messages }),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
  }

  // heard: what the person said. history: [{heard, say}], oldest first,
  // so the ghost can follow a short back-and-forth.
  async function ask({ key, model, personaIndex, heard, history = [] }) {
    const persona = PERSONAS[personaIndex] || PERSONAS[0];
    const messages = [{ role: 'system', content: systemPrompt(persona) }];
    for (const h of history.slice(-3)) {
      messages.push({ role: 'user', content: h.heard });
      messages.push({ role: 'assistant', content: JSON.stringify({ say: h.say, cycle: h.cycle || 'peer' }) });
    }
    messages.push({ role: 'user', content: heard });
    return parseReply(await chat({ key, model, messages }));
  }

  root.GhostBrain = { PERSONAS, REPLY_CYCLES, MAX_SAY, DEFAULT_MODEL, BLE, SETTING, systemPrompt, cleanSay, parseReply, chat, ask };
})(typeof globalThis !== 'undefined' ? globalThis : window);
