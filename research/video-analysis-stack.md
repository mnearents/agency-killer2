# Video Analysis Stack Research

> **Date:** July 2026
> **Context:** Rad & Happy (stationery e-commerce). ~10-20 videos/month, 1-30 min each. Goal: automated editing of marketing content (Instagram Reels, Meta ads). Previous stack: Twelve Labs (Pegasus, free tier) + AssemblyAI.
>
> **Note:** WebSearch and WebFetch were unavailable during this research. Pricing figures are based on published rates as of early-mid 2025. Verify current pricing before committing to a provider -- services in this space change pricing frequently.

---

## Table of Contents

1. [Service-by-Service Evaluation](#1-service-by-service-evaluation)
   - [Twelve Labs](#11-twelve-labs)
   - [AssemblyAI](#12-assemblyai)
   - [Anthropic Claude Vision](#13-anthropic-claude-vision)
   - [Alternatives (Deepgram, Whisper, Google Video Intelligence)](#14-alternatives)
2. [Head-to-Head Comparison](#2-head-to-head-comparison)
3. [Hybrid Architecture Options](#3-hybrid-architecture-options)
4. [Recommended Stack](#4-recommended-stack)
5. [Cost Projections](#5-cost-projections)
6. [Open Questions to Verify](#6-open-questions-to-verify)

---

## 1. Service-by-Service Evaluation

### 1.1 Twelve Labs

**What it is:** A video understanding platform that indexes video and lets you search/query it semantically. Models include Marengo (search/embedding) and Pegasus (generation/summarization).

#### Capabilities

| Capability | Support | Notes |
|---|---|---|
| Scene boundary detection | Good | Implicit via temporal search -- you can query for scene changes, but it's not a dedicated scene-detection endpoint. Works best when combined with semantic queries ("find where the speaker changes topic"). |
| Visual tagging / objects | Strong | Marengo indexes visual content: objects, actions, text on screen, people. Semantic search returns timestamped results. |
| Text on screen (OCR) | Yes | Indexes on-screen text as part of its multimodal understanding. Not a dedicated OCR -- accuracy varies with text size/clarity. |
| Transcription | Yes | Built-in speech-to-text as part of indexing. Quality is decent but not best-in-class for word-level timestamps compared to dedicated transcription APIs. |
| Blooper/mistake detection | Weak | No explicit "quality detection" feature. You can try semantic queries like "blurry footage" or "awkward pause" but this is unreliable. Twelve Labs understands content semantics, not production quality. |
| Content semantics | Strong | Pegasus can generate summaries, answer questions about video content, and describe what's happening. This is its core strength. |

#### Pricing (verify -- based on early 2025)

- **Free tier:** 15 hours/month of indexing. This is generous for the stated volume (10-20 videos x 1-30 min = ~2.5-10 hrs/month). You likely fit in the free tier.
- **Paid:** ~$0.05-0.10/min for indexing (varies by model/features enabled). Generating with Pegasus has per-query costs.
- **Rate limits:** Free tier has lower concurrency. Paid tiers are more generous.

#### Strengths for This Use Case

- Single API gives you visual search, content understanding, and basic transcription.
- Pegasus can answer rich semantic questions ("is the speaker showing a product?" "what's the mood of this segment?").
- Free tier covers the expected volume.

#### Weaknesses for This Use Case

- Scene boundaries are inferred, not explicitly detected -- you'd need to build logic on top of temporal search results.
- Transcription quality and word-level timestamp precision lag behind AssemblyAI/Deepgram.
- No native "visual quality" scoring (blur, exposure, framing).
- API maturity is still evolving -- occasional breaking changes, documentation gaps.
- Vendor lock-in risk: small company, niche product.

---

### 1.2 AssemblyAI

**What it is:** Audio/speech intelligence API. Best-in-class transcription with extensive post-processing features.

#### Capabilities

| Capability | Support | Notes |
|---|---|---|
| Transcription accuracy | Excellent | Consistently top-tier in benchmarks. Universal-2 model handles diverse accents, background noise, and casual speech well. |
| Word-level timestamps | Excellent | Core feature. Precise word-level timing is critical for automated editing (aligning cuts to speech). |
| Speaker diarization | Strong | Identifies different speakers. Useful for interview-style content. |
| Silence detection | Yes | Via word timestamps -- gaps between words reveal pauses/silences. |
| Sentiment analysis | Yes | Per-sentence or per-segment sentiment. Useful for finding enthusiastic vs. flat delivery. |
| Content moderation | Yes | Detects profanity, sensitive topics. |
| Summarization | Yes | LeMUR feature (LLM layer) can summarize, answer questions, extract action items from transcript. |
| Scene detection | No | Audio only -- no visual analysis at all. |
| Visual anything | No | Audio only. |

#### Pricing (verify -- based on early 2025)

- **Pay-as-you-go:** ~$0.37/hr (~$0.006/min) for base transcription.
- **Speaker diarization:** Included or small add-on depending on plan.
- **Sentiment analysis:** Add-on cost.
- **LeMUR (LLM features):** Token-based pricing on top.
- **Free tier:** Some free credits for new accounts (varies, often ~100 hrs).

#### Strengths for This Use Case

- Word-level timestamps are essential for finding cut points aligned to speech.
- Silence/pause detection (derived from timestamp gaps) directly supports blooper detection.
- Sentiment per segment helps identify "flat" takes vs. energetic ones.
- Very reliable API, good documentation, stable.
- Extremely cost-effective at this volume.

#### Weaknesses for This Use Case

- Audio only. Tells you nothing about what's on screen.
- Cannot detect visual issues (blur, bad framing, wrong product in frame).

---

### 1.3 Anthropic Claude Vision

**What it is:** Claude's multimodal capability -- you send images (frames extracted from video) and get rich natural-language analysis.

#### Capabilities

| Capability | Support | Notes |
|---|---|---|
| Visual description | Excellent | Claude can describe what's in a frame with high detail: objects, people, actions, mood, composition, text, branding. |
| Text on screen (OCR) | Very good | Reads text in images accurately, including stylized/branded text. |
| Object recognition | Strong | Identifies products, props, backgrounds, people, gestures. |
| Quality assessment | Good | Can assess blur, exposure, framing, "does this look professional?" -- but requires explicit prompting and is subjective. |
| Blooper detection | Moderate | Can spot obvious issues (eyes closed, mid-blink, motion blur, awkward expression) when prompted. Cannot detect audio issues. |
| Scene semantics | Excellent | "Is this a product close-up or a talking head?" "Is the speaker smiling?" "What emotion does this convey?" -- Claude excels here. |
| Scene boundary detection | Poor natively | You'd need to extract frames and compare adjacent descriptions. Doable but clunky and expensive compared to dedicated tools. |
| Temporal understanding | None | Each frame is analyzed independently. No native concept of "what happened before/after." You must build temporal logic yourself. |

#### Pricing and Throughput

**Key constraint: Claude processes images, not video natively.** You must extract frames and send them as images.

- **Images per request:** Up to 20 images per message (API limit as of early 2025; may have increased). With prompt caching, you can batch efficiently.
- **Token cost per image:** Each image costs tokens based on resolution. A 1568x1568 image costs ~1600 input tokens. A 768x768 image costs ~800 tokens.
- **Cost calculation for 1 minute of video at 1 fps:**
  - 60 frames x ~800 tokens each = ~48,000 input tokens
  - Plus output tokens for descriptions (~500 tokens per frame = 30,000 output tokens)
  - At Claude Sonnet pricing (~$3/M input, ~$15/M output): ~$0.14 + ~$0.45 = **~$0.59/min**
  - At Claude Haiku pricing (~$0.25/M input, ~$1.25/M output): ~$0.012 + ~$0.038 = **~$0.05/min**
- **Cost at 0.5 fps (every 2 seconds) -- more practical:**
  - 30 frames/min: roughly half the above.
  - Haiku: ~$0.025/min. Sonnet: ~$0.30/min.
- **Cost at 0.2 fps (every 5 seconds) -- coarse scan:**
  - 12 frames/min: Haiku ~$0.01/min, Sonnet ~$0.12/min.

**For 10 hrs/month of footage at 0.5 fps with Haiku: ~$15/month. With Sonnet: ~$180/month.**

#### Strengths for This Use Case

- Richest semantic understanding of any option. Can answer arbitrary questions about frame content.
- Can assess subjective quality ("does this frame look professional for a marketing ad?").
- No vendor lock-in to a niche video API -- Claude is a general-purpose tool you're already using.
- Can be prompted with brand-specific context ("Rad & Happy uses pastel colors and playful typography -- does this frame match the brand?").
- Flexible: different prompts for different passes (quality scan, content tagging, text extraction).

#### Weaknesses for This Use Case

- No temporal/motion understanding. Can't detect jump cuts, camera movements, or transitions.
- Frame extraction is your responsibility (FFmpeg pipeline needed).
- More expensive per minute than Twelve Labs at high frame rates.
- Latency: analyzing many frames serially is slow. Need parallel requests.
- No audio analysis at all.

---

### 1.4 Alternatives

#### Deepgram

- **Pricing:** ~$0.0043/min (Nova-2 model, pay-as-you-go). Cheapest option.
- **Accuracy:** Very competitive with AssemblyAI. Nova-2 is strong on English.
- **Word-level timestamps:** Yes, good precision.
- **Speaker diarization:** Yes.
- **Differentiator:** Fastest processing speed. Real-time capable.
- **Weakness vs. AssemblyAI:** Fewer post-processing features (no built-in sentiment, summarization). Less mature LLM integration.
- **Verdict:** Viable alternative to AssemblyAI if you only need transcription + timestamps. AssemblyAI's sentiment analysis is a meaningful advantage for detecting "good" vs. "flat" takes.

#### OpenAI Whisper (self-hosted)

- **Pricing:** Free (compute cost only). Running on a Mac with whisper.cpp or faster-whisper is essentially free for this volume.
- **Accuracy:** Very good for clean audio, slightly below AssemblyAI/Deepgram on noisy audio or accented speech.
- **Word-level timestamps:** Yes, via whisper-timestamped or faster-whisper.
- **Speaker diarization:** Not built in. Requires pyannote.audio or similar (adds complexity).
- **Differentiator:** Zero marginal cost. Full control. No API dependency.
- **Weakness:** You own the infrastructure. No sentiment, no summarization, no content moderation. Word-level timestamp precision is slightly worse than dedicated APIs.
- **Verdict:** Good fallback if cost becomes an issue, but at 10 hrs/month the API cost savings (~$3/month) don't justify the operational overhead.

#### Google Cloud Video Intelligence API

- **Scene detection:** Yes -- dedicated shot change detection. This is Google's strength.
- **Object tracking:** Yes, with bounding boxes and temporal tracking.
- **Text detection (OCR):** Yes, robust.
- **Label detection:** Yes, frame-level and shot-level labels.
- **Pricing:** ~$0.10/min for label detection, ~$0.05/min for shot detection, ~$0.15/min for text detection. Features are priced separately and stack.
- **Differentiator:** Best-in-class shot/scene boundary detection. Purpose-built for this.
- **Weakness:** Labels are generic ("person", "table", "text"), not semantically rich like Claude or Twelve Labs. No "understanding" -- just classification.
- **Verdict:** Worth considering specifically for scene boundary detection if that proves to be a bottleneck. Could complement Claude vision.

#### FFmpeg Scene Detection (free, local)

- **What:** `ffmpeg -filter:v "select='gt(scene,0.3)'"` detects scene changes by measuring frame difference.
- **Pricing:** Free. Runs locally.
- **Quality:** Detects hard cuts reliably. Poor at detecting gradual transitions, topic changes, or semantic scene boundaries.
- **Verdict:** Use this as a pre-processing step regardless of other choices. It's free, fast, and gives you hard-cut timestamps that other tools can refine.

#### PySceneDetect (free, local)

- **What:** Python library for scene detection. More sophisticated than raw FFmpeg -- supports content-aware detection, threshold tuning, adaptive detection.
- **Pricing:** Free.
- **Quality:** Better than FFmpeg for gradual transitions. Still purely visual (pixel-level), no semantic understanding.
- **Verdict:** Strong complement to any stack. Use for initial scene segmentation before sending segments to Claude or Twelve Labs.

---

## 2. Head-to-Head Comparison

| Criterion | Twelve Labs | AssemblyAI | Claude Vision | Deepgram | Google Video AI |
|---|---|---|---|---|---|
| **Scene boundaries** | Moderate (semantic search) | N/A (audio only) | Poor (frame-by-frame) | N/A | Excellent (dedicated) |
| **Visual richness** | Good (indexed search) | N/A | Excellent (free-form) | N/A | Weak (labels only) |
| **Transcription** | Decent | Excellent | N/A | Excellent | N/A |
| **Word timestamps** | Basic | Excellent | N/A | Very good | N/A |
| **OCR / text on screen** | Good | N/A | Very good | N/A | Good |
| **Blooper detection** | Weak | Moderate (silence/filler) | Moderate (visual only) | Weak | None |
| **Cost (10 hrs/mo)** | Free tier | ~$3-4 | $15-180 (varies) | ~$2-3 | ~$30-90 |
| **API maturity** | Growing | Mature | Mature | Mature | Mature |
| **Semantic understanding** | Strong | Moderate (LeMUR) | Excellent | Weak | Weak |

---

## 3. Hybrid Architecture Options

### Option A: AssemblyAI + Claude Vision (skip Twelve Labs)

```
Video file
  |
  +---> FFmpeg/PySceneDetect --> scene boundaries (free, local)
  |
  +---> FFmpeg frame extraction --> Claude Vision (Haiku)
  |       - Visual quality scoring (blur, framing)
  |       - Content tagging (product shots, talking head, B-roll)
  |       - Text on screen extraction
  |       - Brand consistency check
  |
  +---> AssemblyAI transcription
          - Word-level timestamps
          - Speaker diarization
          - Sentiment analysis (energy/engagement scoring)
          - Silence/filler word detection
```

**Pros:**
- Richest semantic understanding (Claude can answer any question about the visuals).
- AssemblyAI gives best-in-class timestamps for audio-aligned cuts.
- No Twelve Labs dependency (smaller vendor risk).
- Claude is already in the stack for other purposes.
- Flexible: can change prompts without changing provider.

**Cons:**
- Higher cost than Twelve Labs free tier for visual analysis.
- Claude has no temporal awareness -- you must build scene continuity logic.
- More complex pipeline (frame extraction, batching, parallel requests).
- Two API bills instead of one.

**Estimated cost (10 hrs/month):**
- AssemblyAI: ~$3-4/month
- Claude Haiku at 0.5 fps: ~$15/month
- Claude Sonnet for key frames only (e.g., 1 per scene): ~$5-10/month
- Total: **~$20-30/month**

### Option B: Twelve Labs + AssemblyAI (previous stack, enhanced)

```
Video file
  |
  +---> Twelve Labs indexing
  |       - Visual scene understanding
  |       - Semantic search for content types
  |       - Text on screen
  |
  +---> AssemblyAI transcription
          - Word-level timestamps
          - Speaker diarization
          - Sentiment analysis
```

**Pros:**
- Proven stack (used in previous project).
- Twelve Labs free tier covers the volume.
- Simpler pipeline (no frame extraction needed).
- Lower cost.

**Cons:**
- Twelve Labs' scene detection is implicit, not explicit.
- Less flexibility in visual analysis (can't ask arbitrary questions).
- Can't assess visual quality (blur, framing) well.
- Vendor risk with Twelve Labs.
- No brand-specific visual assessment.

**Estimated cost (10 hrs/month):**
- Twelve Labs: Free (15 hrs/month tier)
- AssemblyAI: ~$3-4/month
- Total: **~$3-4/month**

### Option C: Twelve Labs (coarse) + Claude Vision (rich) + AssemblyAI

```
Video file
  |
  +---> FFmpeg/PySceneDetect --> hard cut detection (free, local)
  |
  +---> Twelve Labs indexing --> coarse content map
  |       - "Where are the product shots?"
  |       - "Where does the speaker change topic?"
  |       - Quick semantic search without frame extraction
  |
  +---> Claude Vision (targeted frames only)
  |       - Analyze key frames identified by Twelve Labs/PySceneDetect
  |       - Rich quality assessment on scene-start frames
  |       - Brand consistency on hero shots
  |       - ~2-5 frames per scene, not every frame
  |
  +---> AssemblyAI transcription
          - Word-level timestamps
          - Sentiment per segment
```

**Pros:**
- Best of all worlds: Twelve Labs for fast coarse pass, Claude for deep analysis, AssemblyAI for audio.
- Claude costs stay low because you only analyze key frames (maybe 50-100 frames per video instead of 900+).
- Twelve Labs handles the "where is stuff" question; Claude handles the "is it good" question.

**Cons:**
- Three services to maintain.
- Most complex pipeline.
- Twelve Labs dependency remains.

**Estimated cost (10 hrs/month):**
- Twelve Labs: Free
- AssemblyAI: ~$3-4/month
- Claude (key frames only, Haiku): ~$3-5/month
- Total: **~$6-10/month**

### Option D: AssemblyAI + PySceneDetect + Claude Vision (targeted) -- no Twelve Labs

```
Video file
  |
  +---> PySceneDetect --> scene boundaries (free, local)
  |
  +---> FFmpeg: extract 1 frame per scene + scene-transition frames
  |
  +---> Claude Vision (Haiku, targeted)
  |       - Classify each scene (talking head / product shot / B-roll / text card)
  |       - Quality score for scene-start frame
  |       - OCR any text on screen
  |       - Brand consistency flag
  |
  +---> Claude Vision (Sonnet, selective)
  |       - Only for scenes flagged as "needs deeper analysis"
  |       - Rich semantic description for edit decision support
  |       - Blooper assessment (awkward expression, eyes closed, etc.)
  |
  +---> AssemblyAI transcription
          - Word-level timestamps
          - Sentiment / energy scoring
          - Filler word detection ("um", "uh", "like")
```

**Pros:**
- No Twelve Labs dependency.
- PySceneDetect is free and reliable for hard cuts.
- Two-tier Claude usage (Haiku for bulk, Sonnet for quality) keeps costs low.
- Maximum flexibility in what you ask Claude to evaluate.
- Filler word detection from AssemblyAI is a strong blooper signal.

**Cons:**
- PySceneDetect misses semantic scene changes (same visual setting, different topic).
- No "search your video" capability (Twelve Labs' strength) -- you'd build that with the structured output from Claude + transcript.
- Slightly more code to write vs. Twelve Labs' ready-made search.

**Estimated cost (10 hrs/month):**
- PySceneDetect: Free
- AssemblyAI: ~$3-4/month
- Claude Haiku (1 frame/scene, ~200 scenes/month): ~$1-2/month
- Claude Sonnet (selective, ~50 deep analyses/month): ~$2-5/month
- Total: **~$6-12/month**

---

## 4. Recommended Stack

### Primary recommendation: Option D (AssemblyAI + PySceneDetect + Claude Vision)

**Rationale:**

1. **Twelve Labs is not essential at this scale.** Its main value is semantic video search across large libraries. For 10-20 videos/month where each video is processed once through a pipeline, you don't need an indexed search engine -- you need per-video analysis, which Claude does better.

2. **Claude Vision gives richer, more flexible analysis than Twelve Labs.** You can ask brand-specific questions, assess subjective quality, and change your evaluation criteria without switching providers. Twelve Labs gives you what its models were trained to detect; Claude gives you what you ask for.

3. **PySceneDetect eliminates the need for a paid scene detection service.** It handles hard cuts reliably. Semantic scene changes (same shot, topic shifts) are better detected from the transcript anyway (AssemblyAI + an LLM pass on the transcript).

4. **AssemblyAI remains the best transcription option.** The combination of accuracy, word-level timestamps, sentiment analysis, and filler word detection is unmatched for this use case. At ~$3-4/month for the expected volume, switching to Deepgram or Whisper saves almost nothing while losing features.

5. **Blooper detection is a multi-signal problem** that no single service solves:
   - Visual bloopers (blur, bad framing, eyes closed): Claude Vision on key frames.
   - Audio bloopers (filler words, false starts, "sorry let me redo that"): AssemblyAI transcript analysis.
   - Awkward silences: AssemblyAI timestamp gaps > threshold.
   - Low energy takes: AssemblyAI sentiment scoring.
   - The pipeline should fuse these signals per-segment for a composite quality score.

6. **Cost is reasonable.** ~$6-12/month total is well within budget for a tool that replaces hours of manual editing review.

### Fallback: Option C (add Twelve Labs)

If PySceneDetect + Claude proves insufficient for scene understanding -- specifically if you need to answer questions like "find all the moments where she holds up a planner" across your video library -- add Twelve Labs back as a search/index layer. The free tier covers the volume, so the cost is just complexity.

---

## 5. Cost Projections

Assuming 10 hrs/month of raw footage (the midpoint estimate):

| Component | Monthly Cost | Annual Cost |
|---|---|---|
| PySceneDetect | $0 | $0 |
| AssemblyAI (transcription + sentiment) | ~$4 | ~$48 |
| Claude Haiku (bulk frame classification) | ~$2 | ~$24 |
| Claude Sonnet (selective deep analysis) | ~$4 | ~$48 |
| FFmpeg (local processing) | $0 | $0 |
| **Total** | **~$10** | **~$120** |

At 20 hrs/month (high end): roughly double, so ~$20/month, ~$240/year.

For comparison, Twelve Labs paid tier would be ~$60-120/month for 20 hrs if you exceed the free tier. Google Video Intelligence would be ~$60-180/month for the same volume with multiple features enabled.

---

## 6. Open Questions to Verify

These should be checked against current (July 2026) documentation before finalizing:

- [ ] **Twelve Labs free tier:** Is it still 15 hrs/month? Has the model lineup changed? Any new scene detection or quality assessment features?
- [ ] **AssemblyAI pricing:** Current per-minute rate for Universal-2. Has filler word detection been added or improved? Current sentiment analysis accuracy.
- [ ] **Claude Vision limits:** Current max images per request (was 20, may have increased). Current Haiku and Sonnet pricing. Any native video input support added? (Anthropic has discussed video input -- if available, this changes the architecture significantly.)
- [ ] **Claude native video:** If Claude now accepts video files directly (not just frames), the frame-extraction step disappears and costs may change. This would be a major simplification. Check the latest API docs.
- [ ] **Deepgram Nova-3 or newer:** Any accuracy improvements that close the gap with AssemblyAI on sentiment/filler detection?
- [ ] **PySceneDetect vs. alternatives:** Any new open-source scene detection tools with semantic awareness? TransNetV2 (neural scene detection) may be worth benchmarking.
- [ ] **Google Gemini Vision:** Gemini can process video natively (up to 1 hour). May be a Claude Vision alternative worth evaluating for cost and quality. Gemini's per-token pricing for video could undercut frame-by-frame Claude analysis.

---

## Appendix: Implementation Sketch for Option D

```
# Pseudocode for the recommended pipeline

async def analyze_video(video_path: str) -> VideoAnalysis:
    # Step 1: Local scene detection (free, fast)
    scenes = pyscenedetect.detect(video_path, threshold=30)

    # Step 2: Extract key frames (1 per scene + transitions)
    frames = ffmpeg.extract_frames(video_path, timestamps=[s.start for s in scenes])

    # Step 3: Parallel -- transcription + visual analysis
    transcript_task = assemblyai.transcribe(
        video_path,
        speaker_labels=True,
        sentiment_analysis=True,
        auto_highlights=True,
    )

    visual_task = claude_vision.batch_analyze(
        frames=frames,
        model="haiku",  # bulk pass
        prompt="""Classify this video frame:
        - Type: talking-head | product-closeup | b-roll | text-card | transition | other
        - Quality: 1-10 (sharpness, exposure, framing)
        - Objects: list visible objects
        - Text on screen: extract any visible text
        - Brand match: does this match pastel/playful Rad & Happy aesthetic? yes/no
        - Issues: blur | bad-framing | eyes-closed | motion-blur | none
        """,
    )

    transcript, frame_analyses = await asyncio.gather(transcript_task, visual_task)

    # Step 4: Selective deep analysis (Sonnet) for flagged frames
    flagged = [f for f in frame_analyses if f.quality < 6 or f.issues != "none"]
    deep_analyses = await claude_vision.batch_analyze(
        frames=[frames[f.index] for f in flagged],
        model="sonnet",
        prompt="Detailed quality assessment. What's wrong? Is this usable? ..."
    )

    # Step 5: Fuse signals into per-segment quality scores
    segments = build_segments(scenes, transcript, frame_analyses, deep_analyses)

    # Step 6: Generate edit decision list
    edl = generate_edit_decisions(segments)
    return VideoAnalysis(segments=segments, edl=edl, transcript=transcript)
```

### Key Frame Extraction Strategy

Not every frame needs analysis. A practical approach:

1. **Scene-start frames:** 1 frame at each PySceneDetect cut point. These classify the scene type.
2. **Mid-scene samples:** For scenes longer than 10 seconds, sample 1 frame every 5-10 seconds to catch quality changes within a scene.
3. **Pre-cut frames:** 1 frame from 0.5s before each cut point. These catch "the moment before the speaker stopped" which often reveals the reason for a re-take.

For a typical 10-minute video with 30 scenes, this yields ~60-90 frames instead of 600 (at 1fps) -- a 7-10x cost reduction.

### Blooper Detection Signals

| Signal | Source | Detection Method |
|---|---|---|
| Blurry frame | Claude Vision | Quality score < threshold |
| Bad framing (off-center, cut off) | Claude Vision | Explicit prompt check |
| Eyes closed / mid-blink | Claude Vision | Explicit prompt check |
| Filler words ("um", "uh", "like") | AssemblyAI | Transcript text matching or auto_highlights |
| False starts ("sorry", "wait", "let me redo") | AssemblyAI | Transcript pattern matching |
| Awkward silence (>2s gap) | AssemblyAI | Word timestamp gap analysis |
| Low energy / flat delivery | AssemblyAI | Sentiment score below threshold |
| Inconsistent audio level | FFmpeg (local) | Audio level analysis via `loudnorm` filter |
| Repeated content (multiple takes) | AssemblyAI + LLM | Transcript similarity between segments |
