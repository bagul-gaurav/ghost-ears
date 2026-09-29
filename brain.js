// The ghost's brain: personas, the OpenRouter call, and the Bluetooth
// protocol the badge speaks. Shared by the phone page (index.html here),
// the simulator (simulator/ghost.html) and the offline line generator
// (tools/ghost-lines/make-lines.mjs), so a persona is described once.
//
// Plain script, no modules: it puts everything on globalThis.GhostBrain,
// which works from a <script> tag, from file://, and from Node.

(function (root) {
  // voice: the preset voice (below) the persona starts with.
  // tags: ElevenLabs v4 audio tags that suit it, offered to the model as examples.
  const PERSONAS = [
    { id: 'shy', name: 'Shy', voice: 'pFZP5JQG7iQjIQuC4Bku',
      tags: ['whispers', 'giggles softly', 'nervously', 'gasps', 'sighs happily', 'bashful, tiny voice'],
      prompt: 'You are shy and sweet. You blush easily, speak softly, get flustered by compliments, ' +
              'and are secretly delighted anyone talks to you. Gentle, a little bashful, never mean.' },
    { id: 'dramatic', name: 'Dramatic', voice: 'N2lVS1w4EtoT3dr4eOWO',
      tags: ['booming', 'gasps', 'dramatic pause', 'spooky echo', 'laughs maniacally', 'wails'],
      prompt: 'You are a dramatic, theatrical spooky ghost. Everything is a grand haunting. You say ' +
              'things like "BEHOLD" and "woooo", treat small things as epic, and are playful, never scary.' },
    { id: 'sassy', name: 'Sassy', voice: 'FGY2WhTYpPnrIDTdsKH5',
      tags: ['scoffs', 'sarcastically', 'smirks', 'unimpressed', 'laughs', 'sing-song'],
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
  //     "E"               the conversation is over (the ghost goes back to idling)
  //   A long-press during a conversation sends "L" again; the phone takes it
  //   as "stop" and answers "E".
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
      'Reply ONLY with JSON: {"say": "...", "voice": "...", "cycle": "..."}\n' +
      `- "say": your reply, at most 8 words and ${MAX_SAY} characters. Plain ASCII: no emoji, no curly quotes.\n` +
      '- "voice": the same words as "say", as an actor would perform them aloud. Add 1 or 2 audio tags in ' +
      `square brackets where they fit, such as ${persona.tags.map(t => `[${t}]`).join(', ')}, or any short ` +
      'delivery note like [excited, happy]. You may add a small sound ("hehe", "woooo", "ahem"), "..." for a ' +
      'pause, and CAPS for emphasis. No new sentences.\n' +
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

  // The spoken line: no length limit to fit, but kept short and on one line.
  const cleanVoice = s => String(s || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

  // The model is asked for JSON but may wrap it in prose or a code fence.
  // voice is the line with audio tags for ElevenLabs; it falls back to say.
  function parseReply(text) {
    let say = text, voice = '', cycle = 'peer';
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        const j = JSON.parse(text.slice(a, b + 1));
        if (j.say) say = j.say;
        if (j.voice) voice = j.voice;
        if (REPLY_CYCLES.includes(j.cycle)) cycle = j.cycle;
      } catch (e) { /* keep the raw text */ }
    }
    say = cleanSay(say);
    return { say, voice: cleanVoice(voice) || say, cycle };
  }

  // Fast, cheap models that suit a quick quip; they head the model dropdown.
  // Checked against OpenRouter's list on 2026-09-29. The ones it no longer
  // has are dropped when the live list loads.
  const SUGGESTED_MODELS = [
    'anthropic/claude-haiku-4.5', 'openai/gpt-5-mini', 'openai/gpt-4.1-mini', 'openai/gpt-4o-mini',
    'google/gemini-2.5-flash', 'google/gemini-2.5-flash-lite', 'deepseek/deepseek-chat-v3.1',
    'meta-llama/llama-3.3-70b-instruct', 'mistralai/mistral-small-3.2-24b-instruct',
  ];

  // "$1/$5": dollars per million tokens in / out.
  function modelPrice(pricing = {}) {
    const m = p => { const d = +p * 1e6; return d === 0 ? '0' : d < 1 ? d.toFixed(2).replace(/0$/, '') : +d.toFixed(1) + ''; };
    if (+pricing.prompt === 0 && +pricing.completion === 0) return 'free';
    return `$${m(pricing.prompt)}/$${m(pricing.completion)}`;
  }

  // OpenRouter's text models (public, no key needed):
  // { suggested: [...], groups: [{ provider, models: [...] }] }, each model { id, name, price }.
  async function listModels() {
    const res = await fetch('https://openrouter.ai/api/v1/models');
    if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
    const all = (await res.json()).data
      .filter(m => (m.architecture?.output_modalities || ['text']).includes('text'))
      .map(m => ({ id: m.id, name: m.name.replace(/^[^:]+:\s*/, ''), price: modelPrice(m.pricing) }));
    const suggested = SUGGESTED_MODELS.map(id => all.find(m => m.id === id)).filter(Boolean);
    const byProvider = {};
    for (const m of all) (byProvider[m.id.split('/')[0]] ||= []).push(m);
    const groups = Object.keys(byProvider).sort()
      .map(provider => ({ provider, models: byProvider[provider].sort((a, b) => a.name.localeCompare(b.name)) }));
    return { suggested, groups };
  }

  // Fills a <select> with the models: the suggested ones first, then every
  // model by provider. Until the list loads (or if it can't), it holds the
  // suggested ids. The chosen model is kept even if the list lacks it.
  async function fillModelSelect(select, chosen) {
    const option = (id, text) => { const o = document.createElement('option'); o.value = id; o.textContent = text; return o; };
    const group = (label, models) => {
      const g = document.createElement('optgroup'); g.label = label;
      for (const m of models) g.appendChild(option(m.id, m.name ? `${m.name} · ${m.price}` : m.id));
      return g;
    };
    const fill = (suggested, groups) => {
      select.innerHTML = '';
      select.appendChild(group('Suggested: fast', suggested));
      for (const g of groups) select.appendChild(group(g.provider, g.models));
      if (chosen && !select.querySelector(`option[value="${CSS.escape(chosen)}"]`)) select.prepend(option(chosen, chosen));
      select.value = chosen || DEFAULT_MODEL;
    };
    fill(SUGGESTED_MODELS.map(id => ({ id })), []);
    try { const { suggested, groups } = await listModels(); fill(suggested, groups); }
    catch (e) { /* offline: the suggested ids will do */ }
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
      messages.push({ role: 'assistant', content: JSON.stringify({ say: h.say, voice: h.voice || h.say, cycle: h.cycle || 'peer' }) });
    }
    messages.push({ role: 'user', content: heard });
    return parseReply(await chat({ key, model, messages }));
  }

  // --- Voice ---------------------------------------------------------------
  // Replies can be spoken as well as shown. Each persona has its own voice.
  // With an ElevenLabs key it speaks the reply's "voice" line through Eleven
  // v4 Turbo, which acts out the [audio tags] in it; without a key (or with
  // "own voice" picked) it falls back to the browser's voice, pitched up,
  // with the tags stripped. Stability goes to ElevenLabs (v4 takes 0, 0.5
  // or 1: creative, natural, robust; lower acts the tags out more), pitch
  // and rate to the browser.
  const VOICE_STYLE = [
    { stability: 0.5, pitch: 1.8, rate: 0.95 },   // shy: soft and even
    { stability: 0,   pitch: 1.5, rate: 0.9  },   // dramatic: big swings
    { stability: 0.5, pitch: 1.7, rate: 1.1  },   // sassy: quick
  ];
  const ELEVEN_MODEL = 'eleven_v4_turbo';   // follows audio tags, ~100 ms
  // ElevenLabs' premade voices, which work with any key and need no Load.
  // ElevenLabs retires these defaults on 2026-12-31; after that, Load your
  // account's voices and pick replacements.
  const PRESET_VOICES = [
    { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily',      note: 'soft, warm, British' },
    { id: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica',   note: 'young, playful' },
    { id: 'FGY2WhTYpPnrIDTdsKH5', name: 'Laura',     note: 'quirky, upbeat' },
    { id: '9BWtsMINqrJLrRacOk9x', name: 'Aria',      note: 'expressive' },
    { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah',     note: 'bright, confident' },
    { id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice',     note: 'clear, British' },
    { id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda',   note: 'friendly, warm' },
    { id: 'SAz9YHcvj6GT2YYXdXww', name: 'River',     note: 'calm, neutral' },
    { id: 'N2lVS1w4EtoT3dr4eOWO', name: 'Callum',    note: 'husky trickster' },
    { id: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie',   note: 'casual, Australian' },
    { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George',    note: 'warm storyteller' },
    { id: 'bIHbv24MWmeRgasZH58o', name: 'Will',      note: 'chill, friendly' },
  ];
  const OWN_VOICE = 'own';   // the select value for the browser's own voice
  // Words in an ElevenLabs voice's name or labels that suggest a cute voice.
  const CUTE = /cute|child|kid|young|playful|animat|cartoon|sweet|squeak|high|girl|fairy|elf/i;

  let playing = null;   // { stop() } for whatever is being spoken now

  function stopVoice() { playing?.stop(); playing = null; }

  // The account's voices, cutest-sounding first: [{ id, name, note }].
  async function listVoices(elevenKey) {
    const res = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': elevenKey } });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const { voices = [] } = await res.json();
    return voices.map(v => {
      const note = [v.description, ...Object.values(v.labels || {})].filter(Boolean).join(', ');
      return { id: v.voice_id, name: v.name, note, cute: CUTE.test(v.name + ' ' + note) };
    }).sort((a, b) => b.cute - a.cute || a.name.localeCompare(b.name));
  }

  // The voice pickers, one per persona, shared by the phone page and the
  // simulator. Adds a <label> and <select> per persona to container. Each
  // choice is kept in store as ghost.voice.<persona id>, with its name so an
  // account voice still shows before Load. Returns
  //   voiceId(i)       the persona's voice id, '' for the browser's own voice
  //   load(elevenKey)  adds the account's voices; resolves to how many
  function voicePicker(container, store, ownLabel) {
    const option = (id, text) => { const o = document.createElement('option'); o.value = id; o.textContent = text; return o; };
    const group = (label, voices) => {
      const g = document.createElement('optgroup'); g.label = label;
      for (const v of voices) g.appendChild(option(v.id, (v.cute ? '★ ' : '') + v.name + (v.note ? ' · ' + v.note : '')));
      return g;
    };
    const selects = PERSONAS.map(p => {
      const label = document.createElement('label'), sel = document.createElement('select');
      label.textContent = p.name;
      label.htmlFor = sel.id = 'voice-' + p.id;
      sel.style.width = '100%';
      sel.onchange = () => {
        store.set('ghost.voice.' + p.id, sel.value);
        store.set('ghost.voiceName.' + p.id, sel.selectedOptions[0]?.textContent || '');
      };
      container.append(label, sel);
      return sel;
    });
    let account = [];
    function fill() {
      selects.forEach((sel, i) => {
        const p = PERSONAS[i], chosen = sel.value || store.get('ghost.voice.' + p.id) || p.voice;
        sel.innerHTML = '';
        sel.append(option(OWN_VOICE, ownLabel), group('Presets', PRESET_VOICES));
        if (account.length) sel.append(group('Your voices', account));
        if (!sel.querySelector(`option[value="${CSS.escape(chosen)}"]`)) sel.append(option(chosen, store.get('ghost.voiceName.' + p.id) || 'Saved voice'));
        sel.value = chosen;
      });
    }
    fill();
    return {
      voiceId: i => (selects[i] && selects[i].value !== OWN_VOICE ? selects[i].value : ''),
      async load(elevenKey) {
        account = (await listVoices(elevenKey)).filter(v => !PRESET_VOICES.some(p => p.id === v.id));
        fill();
        return account.length;
      },
    };
  }

  // Fetches the audio first and returns play(), so the bubble and the voice
  // can start together. play() resolves when it has finished (or was stopped).
  // text may carry [audio tags]; ElevenLabs acts them out, the browser skips them.
  async function prepareVoice(text, { personaIndex = 0, elevenKey = '', voiceId = '' } = {}) {
    const st = VOICE_STYLE[personaIndex] || VOICE_STYLE[0];
    // A guard in case the end event never comes (it sometimes doesn't in Chrome).
    const guard = (resolve) => setTimeout(resolve, 4000 + 150 * text.length);

    // A line that is only [tags] and emoji has nothing to say; ElevenLabs
    // rejects it (400, "empty text"), so hold the bubble briefly in silence.
    const words = text.replace(/\[[^\]]*\]/g, ' ').replace(/[^\p{L}\p{N}]/gu, '');
    if (!words) return () => new Promise(resolve => {
      const t = setTimeout(done, 1500);
      function done() { clearTimeout(t); resolve(); }
      playing = { stop: done };
    });

    if (elevenKey && voiceId) {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_64`, {
        method: 'POST',
        headers: { 'xi-api-key': elevenKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({
          text, model_id: ELEVEN_MODEL,
          voice_settings: { stability: st.stability, similarity_boost: 0.75 },
        }),
      });
      if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const url = URL.createObjectURL(await res.blob());
      return () => new Promise(resolve => {
        const audio = new Audio(url), t = guard(done);
        function done() { clearTimeout(t); audio.pause(); URL.revokeObjectURL(url); resolve(); }
        playing = { stop: done };
        audio.onended = audio.onerror = done;
        audio.play().catch(done);
      });
    }

    const synth = root.speechSynthesis;
    if (!synth) throw new Error('This browser cannot speak. Add an ElevenLabs key.');
    return () => new Promise(resolve => {
      const u = new SpeechSynthesisUtterance(text.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim()), t = guard(done);
      function done() { clearTimeout(t); synth.cancel(); resolve(); }
      u.pitch = st.pitch; u.rate = st.rate;
      u.onend = u.onerror = done;
      playing = { stop: done };
      synth.speak(u);
    });
  }

  // --- Conversation --------------------------------------------------------
  // After each reply it listens again, so people can go back and forth. It
  // ends after CONVO_SILENCE s of quiet, or when stop() is called (a tap, or
  // a long-press on the badge).
  const CONVO_SILENCE = 8;                        // s
  const SAY_BASE = 2.2, SAY_PER_CHAR = 0.07;      // s a bubble stays up; as in 06_ghost.ino
  const sayTime = text => SAY_BASE + SAY_PER_CHAR * text.length;
  const nowS = () => performance.now() / 1000;

  // hooks:
  //   settings()  -> { key, model, personaIndex, lang, speak, elevenKey, voiceId }, read every turn
  //   listening() show "listening..."
  //   thinking(heard)
  //   say({ say, cycle })  show the reply (its voice, if any, starts at the same moment)
  //   error(message)
  //   end(why)    'quiet' (heard nothing at all), 'error', 'bye' (quiet after a reply), 'stopped'
  function conversation(hooks) {
    const Rec = root.SpeechRecognition || root.webkitSpeechRecognition;
    const history = [];
    let active = false, rec = null, timers = [];

    const later = (s, f) => timers.push(setTimeout(f, Math.max(0, s * 1000)));

    function end(why) {
      if (!active) return;
      active = false;
      timers.forEach(clearTimeout); timers = [];
      const r = rec; rec = null;
      try { r?.abort(); } catch (e) {}
      stopVoice();
      hooks.end(why);
    }

    // One turn of listening. "listening..." appears at showAt (s, on the
    // nowS clock) so the last reply's bubble can finish, or sooner if they
    // start talking. The mic is already open meanwhile.
    function listen(first, showAt) {
      const s = hooks.settings();
      const deadline = Math.max(nowS(), showAt) + CONVO_SILENCE;
      let shown = false;
      const show = () => { if (!shown && active) { shown = true; hooks.listening(); } };
      if (showAt <= nowS()) show(); else later(showAt - nowS(), show);

      (function open() {
        const mine = rec = new Rec();
        let heard = '';
        rec.lang = s.lang || 'en-US';
        rec.interimResults = false;
        rec.maxAlternatives = 1;
        rec.onspeechstart = show;
        rec.onresult = e => { heard = e.results[0][0].transcript; };
        rec.onerror = e => { if (e.error !== 'no-speech' && e.error !== 'aborted') hooks.error('Mic: ' + e.error); };
        rec.onend = () => {
          if (rec !== mine || !active) return;
          if (heard) think(heard);
          else if (first) end('quiet');
          else if (nowS() < deadline - 1) open();     // the mic gave up early; keep waiting
          else end('bye');
        };
        try { rec.start(); }
        catch (e) { hooks.error(`Couldn't open the mic (${e.message}).`); end('error'); }
      })();
    }

    async function think(heard) {
      hooks.thinking(heard);
      const s = hooks.settings();
      try {
        const r = await ask({ key: s.key, model: s.model, personaIndex: s.personaIndex, heard, history });
        if (!active) return;
        history.push({ heard, say: r.say, voice: r.voice, cycle: r.cycle });
        if (history.length > 6) history.shift();
        let play = null;
        if (s.speak) {
          try { play = await prepareVoice(r.voice, s); }
          catch (e) { hooks.error('Voice: ' + e.message); }   // still show the bubble
          if (!active) return;
        }
        hooks.say(r);
        const bubbleEnd = nowS() + sayTime(r.say);
        if (play) await play();          // don't listen while it talks, or it hears itself
        if (active) listen(false, bubbleEnd);
      } catch (e) {
        hooks.error(e.message);
        end('error');
      }
    }

    return {
      get active() { return active; },
      start() {
        if (active) return;
        const s = hooks.settings();
        if (!Rec) { hooks.error('No speech recognition in this browser. Use Chrome.'); hooks.end('error'); return; }
        if (!s.key) { hooks.error('Add your OpenRouter key in Settings.'); hooks.end('error'); return; }
        active = true;
        history.length = 0;              // a new conversation, probably a new person
        listen(true, 0);
      },
      stop() { end('stopped'); },
    };
  }

  root.GhostBrain = { PERSONAS, REPLY_CYCLES, MAX_SAY, DEFAULT_MODEL, BLE, SETTING, systemPrompt, cleanSay, parseReply, chat, ask,
                      SUGGESTED_MODELS, listModels, fillModelSelect,
                      VOICE_STYLE, PRESET_VOICES, listVoices, voicePicker, prepareVoice, stopVoice, CONVO_SILENCE, sayTime, conversation };
})(typeof globalThis !== 'undefined' ? globalThis : window);
