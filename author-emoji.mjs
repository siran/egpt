// author-emoji.mjs — pick the emoji for a message author when rendering
// or mirroring across surfaces (TG / WA / shell / extension).
//
// Pure function so the rules can be unit-tested. The shell wraps it with
// resolved EGPT_CONFIG.emojis values; tests pass synthetic options. Every
// regression in this layer has been a fallback-to-❓ caused by an author
// shape we didn't account for (e.g. 'human@chrome-abc' from the extension
// landing as ❓ in WhatsApp because the lookup keyed on the full author
// instead of the bare name).
//
//   author    — the item.author string. Possible shapes:
//                 'system'                    — egpt's status voice
//                 'You'                       — the user typing locally
//                 '<name>'                    — bare session name (rare;
//                                                most items are tagged)
//                 '<name>@<surface>'          — author@<node> e.g. An@kg,
//                                                cx@kg, egpt@kg, human@chrome-abc
//   sessions  — current session map { name: { emoji, brain, ... } }
//   opts      — { user_name, user_emoji, egpt_emoji, persona_emoji, human_emoji }
//
// Resolution order:
//   1. 'system'         → egpt_emoji
//   2. 'You'            → user_emoji
//   3. bare === 'egpt'  → persona_emoji  (the @egpt persona reply voice)
//   4. bare === user_name → user_emoji   (shell user — USER_NAME)
//   5. bare === 'human' → human_emoji    (extension's default tag)
//   6. sessions[bare]   → that session's emoji
//   7. fallback         → '❓'           (genuinely unknown author)

export function emojiForAuthor(author, sessions, opts = {}) {
  const {
    user_name      = 'An',
    user_emoji     = '🦅',
    egpt_emoji     = '🧠',
    persona_emoji  = '🐶',
    human_emoji    = '🌐',
  } = opts;
  if (author === 'system') return egpt_emoji;
  if (author === 'You')    return user_emoji;
  const bare = String(author ?? '').split('@')[0];
  if (bare === 'egpt')      return persona_emoji;
  if (bare === user_name)   return user_emoji;
  if (bare === 'human')     return human_emoji;
  return sessions?.[bare]?.emoji ?? '❓';
}
