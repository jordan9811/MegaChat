# 2026-08-26 (evening) — the first real broadcast, and what it caught

## Objectives

- Stop proving this thing against fake video. Put it on a real stream, on real
  platforms, and find out what actually happens.

## What happened

**We went live on Twitch for twelve minutes and played five MegaChats. Four of
the five were read back successfully off Twitch's own recording.** That is the
first genuine confirmation that the core idea works against a real broadcast
since July, and the picture quality was exactly what the design predicted —
nine of ten measurements at full legibility.

**And then it paid the streamer nothing.**

That is the headline, and it is a real bug, not a technicality. The system
scores its own certainty by averaging across every frame it checks — including
the frames where it looked and the code simply wasn't on screen at that
instant. Codes change every four seconds, so about half of any real sample set
lands between codes. That is completely normal. But those blanks drag the
average down below the threshold that authorises payment, so a streamer who
did everything right, whose badge was perfectly visible, gets zero and a
support ticket instead of their money.

The code comments call this exact outcome "the worst failure this system has."
It happened on the very first real broadcast. It is now written up in full
with the numbers, and deliberately **not** patched in a hurry — it is the part
that moves money, and it deserves its own proof rather than a same-night fix.

**Three more things were broken before we could even get on air**, all found
without wasting a broadcast:

- The Twitch test harness hadn't been able to start for about four weeks. One
  wrong argument meant it launched the server incorrectly and died in the
  first second. Nobody noticed because it can only be run against a real
  stream, so it isn't part of the automated checks.
- The same harness had no login credentials since we locked the routes down
  two days ago, so its very first request was refused.
- Both harnesses played exactly three clips, which is exactly the minimum the
  timing calibration needs, with no margin at all — and real broadcasts
  reliably produce a bad reading about one time in four. Now five.

**The biggest discovery wasn't about Twitch at all.**

Our own recording of a stream — the thing that lets us support platforms that
don't keep replays, like Kick — could never have worked. Two separate faults,
each fatal on its own:

- The recording never started. In real life a streamer claims their channel,
  opens a session, and *then* goes live. We checked for their stream at the
  moment they opened the session, found them offline, and gave up permanently.
- Even if it had started, we saved the wrong minute of video. A live stream
  reaches the public around 12–25 seconds late. We saved the recording the
  instant a MegaChat finished — before the end of that MegaChat had actually
  reached anyone. A thirty-second clip kept maybe ten seconds of itself; a
  ten-second clip kept none.

Both are fixed, and both are now covered by a new test that models the delay
honestly. **Every one of our twenty-three existing tests was blind to this**,
because fake streams publish instantly and real ones don't. The new test's
key line reads *"0 of 8 badge segments visible at clip end"* — the bug stated
as a measurement. After the fix, the same recording reads back sixteen frames
carrying the code. And on tonight's real Twitch broadcast, five recordings
landed at ~24 MB each — the first time this has ever worked outside a
simulation.

**Rumble: the live-status link you gave me is more dangerous than it looks.**
It doesn't just report whether you're live — the response contains your stream
key and ingest server in plain text. Anyone holding that link can broadcast
*as you*. We don't leak it, and there's now a test that fails if anyone ever
makes us start, but you should treat that URL like a password. The good news:
every assumption we'd made about Rumble's data format, purely from their docs,
turned out to be correct.

## Problems and how we handled them

- **The git branch changed underneath this run.** Partway through, the project
  switched to a branch missing about 710 lines of the verification work, and a
  broadcast nearly went out on old code. I caught it and switched back. If
  more than one session or person is working in here at once, that needs
  sorting — it's the kind of thing that silently ruins an expensive test.
- **YouTube: not tested.** Every credential was blank. Skipped and reported
  rather than guessed at, as instructed.
- **pump.fun: cannot be broadcast to.** No ingest address was supplied and the
  project has never had one. Streaming there requires launching a coin, which
  is a real blockchain transaction — not something I'll do. The ownership test
  needs a private key that only you can use, in your own wallet.
- **Rumble: didn't broadcast.** There's no test harness for it, and the ingest
  address you supplied doesn't match what Rumble's own API reports for your
  stream. Pushing to the wrong one fails silently, which is the worst kind of
  failure to spend an attempt on.

## Later the same night — Kick proved, the payout bug fixed, pump.fun attempted

**Kick went from 0 out of 5 to 5 out of 5.** It took three failed broadcasts to
get there, and the reason is worth understanding because it is the same reason
as everything else this month.

Kick stamps every video segment with a wall clock. We had code that saw those
stamps and concluded "we know exactly where we are, no need to measure" — and
skipped the measuring step entirely. But that stamp records when the segment
was *packaged*, and the badge was drawn on screen about twelve seconds
earlier. So every frame we looked at was twelve seconds off, and we never
noticed because we had told ourselves the timeline was already solved. Two
fixes were made to the wrong part of the code before this was measured rather
than guessed at. The stamp is now used as a starting point, with the delay
still measured on top.

**The payout bug is fixed, and it was worse than it looked.** The score that
decides whether a streamer gets paid was silently multiplying two different
things together: how *clearly* we read the badge, and how *often* it was
there. Kick's fifth run read every badge cleanly and aired all five clips —
and would have been paid nothing, because 84% clarity times 62% presence came
to 0.596 against a 0.6 threshold. Those are now two separate numbers with two
separate thresholds. Replaying that same broadcast through the fix, it passes.

Splitting them needed care: simply ignoring the misses would have let someone
flash the badge once per clip and score highly. So presence is now gated in
its own right, in two places.

**pump.fun: attempted, failed at the encoder, and the failure was informative.**
The push never delivered a single frame — the connection was rejected. But
pump.fun reported the stream **live anyway**, within seconds, with nothing
being broadcast. Their "is this person live" flag tracks whether something
connected, not whether video is flowing. That matters because we record that
flag as evidence a streamer was broadcasting, and that evidence gates payment.
Fixed, and it is now impossible for a pump.fun stream publishing nothing to
accumulate proof that it was live.

Two other pump.fun problems, both about identity rather than video: the system
lowercased every handle, which quietly corrupts a Solana coin address (they are
case-sensitive), and it capped handles at 40 characters when a coin address is
44. And two separate parts of the code each had their own opinion about whether
two handles were "the same", which meant the genuine owner of a coin was
refused access to their own session.

**Why the ingest failed is still open.** The likely explanation is that
pump.fun creates a fresh broadcast slot each time you click "go live" and
destroys it when you stop — so the key sent earlier had already expired. That
would make pump.fun the one platform where we cannot broadcast unattended.
It is written down as unproven, and the test that settles it is simply to
capture a key immediately before a run.

## Outstanding

**Owner:**
- **Rotate the credentials you pasted into chat** — the Kick stream key and
  client secret, and especially the Rumble link, which is effectively a
  broadcast password.
- ~~**Kick is still unproven.**~~ **DONE — Kick verified 5 of 5** on its fourth
  real broadcast, matching the synthetic corpus for the first time.
- **Confirm which Rumble ingest address is correct**, or let the harness read
  it from their API.
- **A decision on pump.fun** — the video side is genuinely solved, but paying
  out to a coin rather than a person is a product question.

**Engineering:**
- ~~The confidence-scoring bug above. It is P0 and it blocks real payouts.~~
  **DONE.** Split into clarity and presence, each separately gated, with the
  failing broadcast's own numbers written into a test so it cannot come back.
- No cap on total recording storage.
- ~~Captures key on the clip rather than the playback when a clip runs its exact
  declared length.~~ **DONE** — the boundary check was off by one clip rotation.
- **The timing measurement is not yet accurate enough.** Two samples per session
  land on the previous clip and get counted against the streamer. It does not
  stop a payout today, but it leaves less margin than it should.
- **pump.fun ingest** — see above; likely needs a fresh key per run.

## Outlook

**Mid, and for the first time the uncertainty is narrowing rather than moving.**

Tonight did the thing this project has needed for a month: it stopped asking a
simulation whether the idea works and asked a real broadcast. The answer was
mostly yes — the badge survives a real encoder at full legibility, and four of
five clips were provably read back off Twitch's own copy.

The rest of the answer was a list of things that were confidently green and
completely broken. That is four separate cases this month of a passing test
hiding a broken path, and they all share one shape: the test was kinder than
reality. Instant streams instead of delayed ones. One code instead of many. A
check that asked whether the code ran instead of what it found.

What moves this to bullish: fixing the confidence bug and getting one clean
end-to-end payout on a real broadcast — plus the Kick attempt, which is now
genuinely ready. What keeps it from being bearish is that tonight's failures
were all *found*, cheaply, before they cost anything, and every one of them
had been sitting invisible behind a green suite for weeks.
