# Prompt engineering · mood + detail

The SUPER BCS UI ships with a library of cinematic **motion presets** — each
one a single prompt you can use as-is or tweak. How those presets are
structured has a measurable effect on whether the model follows the intent,
so the shape is part of the product.

## The problem

Early versions of the presets were single strings, something like:

> "A pump-it motion · explosive upward price action with neon green candles,
> 24fps, anamorphic lens, 35mm film grain, dust motes in backlight, slight
> camera shake, short focal length"

This *looks* good and sometimes it is good. But image-to-video models treat
tokens near the front of a prompt with higher weight than tokens near the
back, and the above buries the *verb* — the actual motion — somewhere in the
middle of a long cinematography list. The model often latched onto "35mm
film grain" and produced a static-looking grainy frame that barely moved.

## The fix — mood first, detail second

Every preset is now structured as two fields:

```ts
interface Preset {
  label: string    // what the user sees
  mood:  string    // <= 15 words, leading with the VERB, the SUBJECT, the EMOTION
  detail: string   // cinematography (camera, lens, grain, lighting)
}
```

At submit time the two are joined with a middle-dot separator, mood first:

```ts
const prompt = `${preset.mood} · ${preset.detail}`
```

This puts the motion intent squarely in the high-weight region of the prompt
window and demotes cinematography to flavor — which is what we want.

## Worked example

Preset: `PUMP IT`

| Field  | Content                                                             |
|--------|---------------------------------------------------------------------|
| mood   | `An explosive upward surge, neon green price candles rocketing skyward` |
| detail | `anamorphic lens, 35mm film grain, dust motes, subtle camera shake, backlit haze` |
| final  | `An explosive upward surge, neon green price candles rocketing skyward · anamorphic lens, 35mm film grain, dust motes, subtle camera shake, backlit haze` |

The mood is 11 words. The model consistently produces a clip that actually
pumps.

## The hybrid mode

Users can inject their own tweak between mood and detail:

```ts
base = tweak
  ? `${preset.mood} · ${tweak} · ${preset.detail}`
  : `${preset.mood} · ${preset.detail}`
```

This lets a user say "for $BTC logo" or "in an 80s VHS aesthetic" without
disturbing either the verb at the front or the cinematography at the back.

## Why 15 words

Empirically, above 15 words in the mood field the subject starts to drift and
the verb loses dominance. Below 6 words the model has too little to work
with and falls back on generic motion. Twelve to fifteen is the sweet spot
for FLUX-based image-to-video.

## Takeaway

Prompt shape matters at least as much as prompt content. When a model doesn't
behave, the first thing to test is not "what if I add more adjectives" but
"what if the verb was the first thing the model saw."
