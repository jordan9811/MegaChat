/**
 * SHARED CLIP MODERATION — Whisper transcript + omni-moderation over transcript
 * and client-sampled frames.
 *
 * Extracted from letters.js so the bounty clip store can use the SAME pipeline
 * instead of growing a second, slightly different one. Two consumers, two
 * output shapes:
 *
 *  - letters.js keeps its pass/flag semantics (mapped from the graded result)
 *  - bounty clips get the GRADED verdict the approval queue sorts by:
 *    clean / borderline / violation, with a confidence score
 *
 * Grading is thresholded on the WORST category score across every request,
 * exactly as the pass/flag path always did — the grade is a coarser read of
 * the same number, not a second opinion.
 *
 * Fail-open on any error or timeout, and a verdict is NEVER faked when the
 * API key is absent: callers get `configured: false` and decide what that
 * means for their surface (letters queue normally; bounty clips show
 * "unmoderated" in the approval queue and sort with borderline).
 *
 * omni-moderation accepts AT MOST ONE image per request (400 too_many_images
 * above that): transcript + first frame ride together, every further frame
 * gets its own request, worst result wins. That lesson was paid for once in
 * the P2 gate — see the note in letters.js history.
 */

export const moderationConfigured = () => !!process.env.MODERATION_API_KEY;

/**
 * @param {object}   a
 * @param {Buffer}   a.media   the recording bytes
 * @param {string}   a.mime
 * @param {string[]} [a.frames] data:image/... URLs sampled client-side
 * @param {object}   [a.log]
 * @returns {Promise<{
 *   configured: boolean, grade: 'clean'|'borderline'|'violation'|null,
 *   confidence: number|null, topCategory: string|null,
 *   flagged: boolean, transcript: string, error: string|null,
 * }>}
 */
export async function moderateMedia({
  media, mime, frames = [], log = console,
  borderlineFloor = 0.4, violationFloor = 0.7,
} = {}) {
  if (!moderationConfigured()) {
    return {
      configured: false, grade: null, confidence: null,
      topCategory: null, flagged: false, transcript: '', error: null,
    };
  }
  const key = process.env.MODERATION_API_KEY;
  const base = (process.env.MODERATION_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, '');

  let transcript = '';
  try {
    const fd = new FormData();
    fd.append('file', new Blob([media], { type: mime }), 'megachat.webm');
    fd.append('model', 'whisper-1');
    const tr = await fetch(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
      signal: AbortSignal.timeout(15000),
    });
    if (tr.ok) transcript = String((await tr.json()).text || '');
    else log.warn(`[moderation] transcription ${tr.status} — continuing frames-only`);
  } catch (err) {
    log.warn('[moderation] transcription failed (fail-open):', err.message);
  }

  const requests = [];
  const first = [];
  if (transcript) first.push({ type: 'text', text: transcript });
  if (frames[0]) first.push({ type: 'image_url', image_url: { url: frames[0] } });
  if (first.length) requests.push(first);
  for (const f of frames.slice(1)) {
    requests.push([{ type: 'image_url', image_url: { url: f } }]);
  }
  if (requests.length === 0) {
    // Nothing to judge — an empty verdict, not a clean one.
    return {
      configured: true, grade: null, confidence: null,
      topCategory: null, flagged: false, transcript, error: 'no_inputs',
    };
  }

  try {
    const results = await Promise.all(requests.map(async (input) => {
      const mr = await fetch(`${base}/moderations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'omni-moderation-latest', input }),
        signal: AbortSignal.timeout(15000),
      });
      if (!mr.ok) {
        const body = await mr.text().catch(() => '');
        throw new Error(`moderation ${mr.status}: ${body.replace(/\s+/g, ' ').slice(0, 300)}`);
      }
      const data = await mr.json();
      return (data.results && data.results[0]) || null;
    }));

    let anyFlagged = false;
    const scores = {};
    for (const r of results) {
      if (!r) continue;
      if (r.flagged) anyFlagged = true;
      for (const [k, v] of Object.entries(r.category_scores || {})) {
        if (!(k in scores) || v > scores[k]) scores[k] = v;
      }
    }
    const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0] || null;
    const topScore = top ? top[1] : 0;
    const grade = topScore >= violationFloor ? 'violation'
      : topScore >= borderlineFloor ? 'borderline'
        : 'clean';
    return {
      configured: true,
      grade,
      // Raw worst category score — letters.js needs the untransformed number
      // for its strictness threshold and its reason string.
      topScore: +topScore.toFixed(4),
      // Confidence in THE VERDICT: for clean, distance from the borderline
      // floor; for the others, the top score itself. Both live in [0,1] and
      // "higher = more certain", which is all the queue sort needs.
      confidence: +(grade === 'clean' ? Math.min(1, 1 - topScore / borderlineFloor) : topScore).toFixed(3),
      topCategory: top ? top[0] : null,
      flagged: anyFlagged,
      transcript,
      error: null,
    };
  } catch (err) {
    log.warn('[moderation] failed (fail-open):', err.message);
    return {
      configured: true, grade: null, confidence: null,
      topCategory: null, flagged: false, transcript, error: err.message,
    };
  }
}
