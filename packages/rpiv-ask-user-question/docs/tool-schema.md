# Tool schema

The complete programmatic surface of `ask_user_question`: what the model sends, what
validation rejects, what comes back, and the event other extensions can listen to.

## Parameters

```ts
ask_user_question({
  questions: [
    {
      question: string,            // full question text, ends with "?"
      header: string,              // chip label, truncated to 16 cols
      options: [
        {
          label: string,           // 1-5 words, no length cap
          description: string,     // what the choice means / its trade-off
          preview?: string,        // markdown rendered next to the options
        },
        // … 2-4 options total
      ],
      multiSelect?: boolean,       // default false
    },
    // … 1-4 questions total
  ]
})
```

### Limits

| Field | Constraint | Enforced by |
| --- | --- | --- |
| `questions` | 1-4 entries | TypeBox schema + `validateQuestionnaire` |
| `questions[].header` | none; truncated to 16 columns in the chip | render (`TabBar`, inline badge) |
| `questions[].options` | 2-4 entries | TypeBox schema (both bounds) + `validateQuestionnaire` (minimum only) |
| `options[].label` | none; wrapped or clipped to the column | render (`WrappingSelect`, `MultiSelectView`) |
| `options[].preview` | single-select questions only | tool description (multi-select tabs render checkbox rows) |

Neither `header` nor `label` carries a `maxLength`. Over-long text is a display
concern and degrades at render instead of failing the call, so a caller shaped
for another harness's questionnaire tool never loses a turn to a cosmetic field.
The label is never rewritten: it is the answer identity, echoed back verbatim by
`formatAnswerScalar`, and truncating it would both report an answer that was
never offered and risk collapsing two labels that differ only past the cut.

### The "Other" alias

An option labelled `"Other"` is DROPPED by `normalizeQuestionnaire` before the
dialog opens, not rejected. That label names the custom-answer row in the tool
this one stands in for; here the row is appended automatically, so an authored
copy is a duplicate affordance and removing it costs the user no choice.

`"Type something."` and `"Next"` are the runtime sentinel labels but stay valid
option labels: they are ordinary text elsewhere, and dropping them would delete
a real choice. Rows are keyed by `kind` rather than by label, so an authored row
carrying a sentinel's text stays distinct from the sentinel.

Validation runs on the original input, before the drop, so the 2-option floor and
the duplicate-label check judge exactly what the caller sent. `["Real", "Other"]`
therefore passes and renders as one authored option beside the appended row.

## Validation errors

Every rejection returns `cancelled: true`, an empty `answers` array, and an `error`
code. The `content[0].text` string is written for the model, not for a log.

| `error` | Cause |
| --- | --- |
| `no_questions` | `questions` was empty |
| `too_many_questions` | more than 4 questions in one call |
| `duplicate_question` | two questions with identical text |
| `empty_options` | a question carried fewer than 2 options |
| `duplicate_option_label` | two options in one question share a label |
| `no_ui` | the run has no UI (`ctx.hasUI === false`) |
| `no_custom_ui` | the host cannot render custom UI and exposes no `select`/`input` dialogs |
| `session_load_failed` | the dialog module failed to import (dependencies changed on disk mid-session) |
| `stale_module_cache` | the loader cached a broken module after an earlier failed import; needs a Pi restart |


## Result

```ts
{
  content: [{ type: "text", text: string }], // envelope prose, or the decline message
  details: {
    answers: Array<{
      questionIndex: number,
      question: string,
      kind: "option" | "custom" | "multi",
      answer: string | null,       // option label, custom text, or null
      selected?: string[],         // chosen labels, multi-select only; can accompany answer
      notes?: string,              // free-text note, when you wrote one
      preview?: string,            // echoed back when the chosen option carried a preview
    }>,
    cancelled: boolean,
    globalNote?: string,          // Submit-tab note; present even when cancelled is true
    error?: QuestionnaireError,    // one of the codes above
  }
}
```

### Envelope text

On success the text reads `User has answered your questions: "<question>"="<answer>". …
You can now continue with the user's answers in mind.` A chosen option's `preview` is
appended as `selected preview: <markdown>`, a per-question note as `user notes: <text>`,
and the Submit tab's global note as a trailing `global note: <text>` segment. A global
note alone still yields the answered envelope — it counts as an answer even when every
question is blank.

Cancelling, and any result with neither answer segments nor a global note, both collapse
to the single string `User declined to answer questions` so the model sees one canonical
signal. Partial submission is allowed: unanswered questions simply contribute no segment.
A cancelled result always reads as the decline in text; its note, if any, survives only
in `details.globalNote`.

## Event contract

The package publishes one event on Pi's event bus, emitted after validation passes and
before the dialog is shown. Import it from the `/events` subpath:

```ts
import { ASK_USER_PROMPT_EVENT, type AskUserPromptEventPayload } from "@juicesharp/rpiv-ask-user-question/events";

pi.events.on(ASK_USER_PROMPT_EVENT, (payload: AskUserPromptEventPayload) => {
  // payload.questions[].{ question, header, multiSelect, options[] }
  // payload.questions[].options[].{ label, description, hasPreview }
});
```

The channel name is `rpiv:ask-user:prompt`. Preview *content* is deliberately not shipped
in the payload — only `hasPreview: boolean` — so listeners forwarding the event across a
process or network boundary stay cheap.

Stability policy for the `rpiv:*` namespace: channel names are immutable, payload changes
are append-only and always optional, payloads stay JSON-safe, and any breaking change ships
as a new channel (e.g. `rpiv:ask-user:prompt.v2`) rather than a version field.
