import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';

const backgroundSource = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');

test('background routes qwen-mt translation by requestBody.stream', () => {
  assert.match(backgroundSource, /const translationResult = isQwenMtRequest/);
  assert.match(backgroundSource, /\?\s*requestBody\.stream/);
  assert.match(backgroundSource, /translation:\s*await consumeStream\(/);
  assert.match(backgroundSource, /translation:\s*await consumeQwenMtNonStreamResponse\(/);
});

test('background includes non-stream qwen-mt parse failures for malformed responses', () => {
  assert.match(backgroundSource, /async function consumeQwenMtNonStreamResponse/);
  assert.match(backgroundSource, /qwen-mt non-stream response is not valid JSON\./);
  assert.match(backgroundSource, /qwen-mt non-stream response did not include translated content\./);
  assert.match(backgroundSource, /debugLog\('qwen_non_stream_parse_failed'/);
});

const DASHSCOPE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const guide = {
  guideType: 'sentence',
  hints: ['Notice "quiet" and the word 安静.', '"Was" connects the room with its description.'],
  answer: { meaning: 'There was little noise in the room.', explanation: 'Quiet describes the room.' },
  structure: [
    { role: 'subject', text: 'The room' },
    { role: 'verb', text: 'was' },
    { role: 'complement', text: 'quiet' },
  ],
};

async function createHarness(t, provider, { baseUrl = DASHSCOPE_URL, extension = false, model = 'qwen-mt-flash' } = {}) {
  const previousChrome = globalThis.chrome;
  const previousScope = globalThis.ServiceWorkerGlobalScope;
  if (extension) globalThis.ServiceWorkerGlobalScope = class ServiceWorkerGlobalScope {};
  t.after(() => {
    globalThis.chrome = previousChrome;
    globalThis.ServiceWorkerGlobalScope = previousScope;
  });
  const listeners = [];
  const events = [];
  const requests = [];
  globalThis.chrome = {
    providerFetch: () => async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      return provider(body, options.signal);
    },
    runtime: { onMessage: { addListener(fn) { listeners.push(fn); } } },
    storage: {
      onChanged: { addListener() {} },
      sync: { async get() {
        return { base_url: baseUrl, api_key: 'test-key', model, learning_model: 'qwen3.8-flash' };
      } },
    },
    tabs: { sendMessage(_id, { payload }, _options, done) { events.push(payload); done(); } },
  };
  await import(`../src/background.js?structured=${Math.random()}`);
  function dispatch(message) {
    let accepted = false;
    for (const listener of listeners) {
      listener(message, { tab: { id: 2 }, frameId: 1 }, (response) => { accepted ||= response?.accepted; });
    }
    assert.equal(accepted, true);
  }
  return {
    events,
    requests,
    start(text, kind = 'guide', requestId = 'request', options = {}) {
      dispatch({ type: 'START_TRANSLATION', payload: { text, kind, requestId, selectionId: 'selection', ...options } });
    },
    cancel(requestId = 'request', options = {}) {
      dispatch({ type: 'CANCEL_TRANSLATION', payload: { requestId, ...options } });
    },
    async event(status, requestId = 'request') {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const event = events.find((item) => item.status === status && item.requestId === requestId);
        if (event) return event;
        await wait(5);
      }
      assert.fail(`No ${status} event for ${requestId}`);
    },
  };
}

function createSse() {
  const encoder = new TextEncoder();
  let stream;
  const body = new ReadableStream({ start(controller) { stream = controller; } });
  return {
    response: new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }),
    send(content) {
      const data = JSON.stringify({ choices: [{ delta: { content } }] });
      const bytes = encoder.encode(`data: ${data}\r\n\r\n`);
      const unicode = bytes.findIndex((byte) => byte > 127);
      const split = unicode < 0 ? 12 : unicode + 1;
      stream.enqueue(bytes.slice(0, split));
      stream.enqueue(bytes.slice(split));
    },
    end() {
      stream.enqueue(encoder.encode('data: [DONE]'));
      stream.close();
    },
    abort(error) { stream.error(error); },
  };
}

test('desktop DashScope guides preview a complete escaped hint and retain it with final sentence structure', async (t) => {
  const sse = createSse();
  const harness = await createHarness(t, () => sse.response);
  const json = JSON.stringify(guide);
  const firstHintEnd = json.indexOf(JSON.stringify(guide.hints[0])) + JSON.stringify(guide.hints[0]).length + 1;
  const split = json.indexOf('\\"') + 1;
  harness.start('The room was quiet.');
  sse.send(json.slice(0, split));
  sse.send(json.slice(split, firstHintEnd));
  const preview = await harness.event('stream');
  assert.equal(preview.kind, 'guide');
  assert.equal(preview.previewHint, guide.hints[0]);
  assert.equal(preview.result, undefined);
  assert.equal(harness.events.some(({ status }) => status === 'success'), false);
  assert.equal(harness.requests[0].stream, true);
  assert.equal(harness.requests[0].enable_thinking, false);
  assert.deepEqual(harness.requests[0].response_format, { type: 'json_object' });
  sse.send(json.slice(firstHintEnd));
  sse.end();
  const done = await harness.event('success');
  assert.deepEqual(done.result.hints, guide.hints);
  assert.equal(done.result.answer.meaning, guide.answer.meaning);
  assert.deepEqual(done.result.structure.map(({ role }) => role), ['subject', 'verb', 'complement']);
  assert.equal(harness.events.filter(({ status }) => status === 'stream').length, 1);
});

test('desktop DashScope direct single words preview the translation before completing lexical details', async (t) => {
  const sse = createSse();
  const harness = await createHarness(t, () => sse.response);
  harness.start('record', 'translate');
  sse.send('{"translation":"记录",');
  const preview = await harness.event('stream');
  assert.equal(harness.requests[0].model, 'qwen3.8-flash');
  assert.equal(harness.requests[0].stream, true);
  assert.match(harness.requests[0].messages[0].content, /"translation" as the first field/);
  assert.equal(preview.translatedText, '记录');
  assert.equal(preview.lexicalDetails, undefined);
  assert.equal(harness.events.some(({ status }) => status === 'success'), false);
  sse.send('"phonetic":"/ˈrekərd/","definitions":[{"meaning":"记录","pos":"noun"}]}');
  sse.end();
  const done = await harness.event('success');
  assert.equal(done.translatedText, preview.translatedText);
  assert.equal(done.lexicalDetails.phonetic, '/ˈrekərd/');
  assert.equal(done.lexicalDetails.definitions[0].meaning, '记录');
});

test('desktop stream previews never publish hidden answer fields or replace final validation', async (t) => {
  const sse = createSse();
  const harness = await createHarness(t, () => sse.response);
  harness.start('The room was quiet.');
  sse.send('{"answer":{"hints":["Hidden answer"],"meaning":"Hidden answer"},');
  sse.send('"hints":["Real hint"]}');
  sse.end();
  const failure = await harness.event('error');
  assert.match(failure.message, /incomplete reading guide/);
  assert.deepEqual(harness.events.map(({ status }) => status), ['started', 'error']);
});

test('cancelling a previewed guide aborts the stream without publishing a final result', async (t) => {
  const sse = createSse();
  let signal;
  const harness = await createHarness(t, (_body, requestSignal) => {
    signal = requestSignal;
    signal.addEventListener('abort', () => sse.abort(signal.reason), { once: true });
    return sse.response;
  });
  harness.start('The room was quiet.');
  sse.send('{"hints":["Look at the word quiet."]');
  await harness.event('stream');
  harness.cancel();
  assert.equal(signal.aborted, true);
  await wait(0);
  assert.deepEqual(harness.events.map(({ status }) => status), ['started', 'stream']);
});

test('generic endpoints and the browser retain non-streaming guide requests', async (t) => {
  for (const options of [{ baseUrl: 'https://api.example.com/v1' }, { extension: true }]) {
    await t.test(JSON.stringify(options), async (caseTest) => {
      const harness = await createHarness(caseTest, () => Response.json({
        choices: [{ message: { content: JSON.stringify(guide) } }],
      }), options);
      harness.start('The room was quiet.');
      await harness.event('success');
      assert.equal(harness.requests[0].stream, false);
      assert.deepEqual(harness.events.map(({ status }) => status), ['started', 'success']);
    });
  }
});

test('desktop translation finishes before layered analysis and reuses both on a cache hit', async (t) => {
  const text = 'There are some kinds of work that you cannot do alone. To be a scientist';
  const fragment = 'To be a scientist';
  let releaseAnalysis;
  const gate = new Promise((resolve) => { releaseAnalysis = resolve; });
  t.after(() => releaseAnalysis());
  const harness = await createHarness(t, async (body) => {
    const isAnalysis = body.messages[0].content.includes('Return only a JSON object with the key "structure"');
    if (isAnalysis) await gate;
    return Response.json({ choices: [{ message: { content: JSON.stringify(isAnalysis ? {
      structure: [
        { role: 'subject', text: 'There' }, { role: 'verb', text: 'are' },
        { role: 'complement', text: 'some kinds of work' },
      ],
      sentenceAnalysis: {
        connections: [{ text: 'that you cannot do alone', explanation: 'This clause describes work.' }],
        fragments: [{ text: fragment, explanation: 'The main clause is missing from this selection.' }],
      },
    } : { translation: '有些工作不能独自完成。要成为科学家……' }) } }] });
  }, { model: 'generic' });
  harness.start(text, 'translate', 'first', { includeSentenceStructure: true });
  const translated = await harness.event('success', 'first');
  assert.ok(translated.translatedText);
  assert.equal(harness.events.some(({ status }) => status === 'structure'), false);
  releaseAnalysis();
  const analysis = await harness.event('structure', 'first');
  assert.deepEqual(analysis.structure.map(({ role }) => role), ['subject', 'verb', 'complement']);
  assert.equal(text.slice(analysis.sentenceAnalysis.fragments[0].start,
    analysis.sentenceAnalysis.fragments[0].end), fragment);
  await wait(0);
  harness.start(text, 'translate', 'cached', { includeSentenceStructure: true });
  const cached = await harness.event('success', 'cached');
  assert.deepEqual(cached.sentenceAnalysis, analysis.sentenceAnalysis);
  assert.deepEqual(cached.structure, analysis.structure);
  assert.equal(harness.requests.length, 2, 'reuse must not trigger another paid analysis');
});

test('late optional sentence analysis cannot overwrite a newer desktop lookup', async (t) => {
  let finishAnalysis;
  const gate = new Promise((resolve) => { finishAnalysis = resolve; });
  t.after(() => finishAnalysis());
  const harness = await createHarness(t, async (body) => {
    const isAnalysis = body.messages[0].content.includes('Return only a JSON object with the key "structure"');
    if (isAnalysis) await gate;
    return Response.json({ choices: [{ message: { content: JSON.stringify(isAnalysis
      ? { structure: [{ role: 'verb', text: 'left' }] }
      : { translation: 'Translated.' }) } }] });
  }, { model: 'generic' });
  harness.start('She left. To be ready', 'translate', 'old', { includeSentenceStructure: true });
  await harness.event('success', 'old');
  harness.start('New lookup.', 'translate', 'new');
  await harness.event('success', 'new');
  finishAnalysis();
  await wait(10);
  assert.equal(harness.events.some(({ status }) => status === 'structure'), false);
});

test('article sentence analysis runs independently and retries without replacing a completed translation', async (t) => {
  let finishTranslation;
  let finishAnalysis;
  const translationGate = new Promise((resolve) => { finishTranslation = resolve; });
  const analysisGate = new Promise((resolve) => { finishAnalysis = resolve; });
  t.after(() => { finishTranslation(); finishAnalysis(); });
  let analyses = 0;
  const signals = {};
  const harness = await createHarness(t, async (body, signal) => {
    if (body.messages[0].content.includes('Return only a JSON object with the key "structure"')) {
      const data = JSON.parse(body.messages.at(-1).content);
      analyses += 1;
      signals.analysis = signal;
      if (analyses === 1) {
        await analysisGate;
        return new Response('', { status: 503 });
      }
      assert.equal(data.selectedText, 'The room was quiet.');
      return Response.json({ choices: [{ message: { content: JSON.stringify({ structure: guide.structure }) } }] });
    }
    signals.translation = signal;
    await translationGate;
    return Response.json({ choices: [{ message: { content: '{"translation":"安静"}' } }] });
  }, { model: 'generic' });
  harness.start('was quiet', 'translate', 'translation', { requestScope: 'reading', includeSentenceStructure: false });
  await harness.event('started', 'translation');
  harness.start('The room was quiet.', 'structure', 'analysis', { requestScope: 'reading' });
  await harness.event('started', 'analysis');
  assert.equal(signals.translation.aborted, false, 'analysis must not cancel the selected-text request');
  finishTranslation();
  assert.equal((await harness.event('success', 'translation')).translatedText, '安静');
  finishAnalysis();
  assert.match((await harness.event('error', 'analysis')).message, /503/);
  harness.start('The room was quiet.', 'structure', 'retry', { requestScope: 'reading', forceRefresh: true });
  const result = await harness.event('success', 'retry');
  assert.deepEqual(result.result.structure.map(({ role }) => role), ['subject', 'verb', 'complement']);
  assert.equal(harness.events.filter(({ status, requestId }) => status === 'success' && requestId === 'translation').length, 1);
  harness.start('The room was quiet.', 'structure', 'cached', { requestScope: 'reading' });
  const cached = (await harness.event('success', 'cached')).result;
  assert.deepEqual(cached.structure, result.result.structure);
  assert.equal(cached.sentenceAnalysis, result.result.sentenceAnalysis);
  assert.equal(analyses, 2, 'reopening the same sentence reuses its analysis');
});

test('cancelling article analysis leaves a simultaneous selected-text request active', async (t) => {
  const signals = {};
  const harness = await createHarness(t, (body, signal) => {
    const analysis = body.messages[0].content.includes('Return only a JSON object with the key "structure"');
    signals[analysis ? 'analysis' : 'translation'] = signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, { model: 'generic' });
  harness.start('was quiet', 'translate', 'translation', { requestScope: 'reading', includeSentenceStructure: false });
  await harness.event('started', 'translation');
  harness.start('The room was quiet.', 'structure', 'analysis', { requestScope: 'reading' });
  await harness.event('started', 'analysis');
  harness.cancel('analysis', { requestScope: 'reading', kind: 'structure' });
  assert.equal(signals.analysis.aborted, true);
  assert.equal(signals.translation.aborted, false);
  harness.cancel('translation', { requestScope: 'reading' });
});
